/**
 * The capability tools of the daemon's own turns (the web chat and every
 * other hosted session, scheduled and trigger runs, handed-off work):
 * `capability_find` and `capability_run`, the same two a terminal program's
 * model has, run here in process.
 *
 * A call is admitted once, by this turn's own permission gate under the mode of
 * the turn's owner (the definition, built from the daemon's whole catalog, says
 * which calls loosen a protection, cannot be undone or are the owner's own
 * act). It then runs as that owner's model (`agentActor` of the turn's actor,
 * the local owner when the turn names nobody else), never as the program: a
 * moved capability through `capabilities.run`, which admits its effects for
 * that actor; a daemon method by id, or an action with its own method, through
 * the method catalog after its declared effects are admitted for that actor.
 * A conversation's capability is refused: it acts on a terminal program's open
 * conversation. A secret input is hidden from every record of the call
 * (secret-inputs.ts).
 */
import { BUILTIN_GATEWAY_METHODS } from '../../control-plane/method-catalog.js';
import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import { CAPABILITY_RUN_METHOD_ID } from '../../control-plane/method-catalog-capabilities.js';
import type { Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { turnInputParty } from '../../security/turn-input-party.js';
import { turnModelActor, whoseTurn } from '../../security/turn-session.js';
import { isOwnerWorkMethod } from '../../control-plane/owner-work-method.js';
import { RUNS_LATER_METHOD_IDS, riskOfDescriptor } from '../../control-plane/method-risk.js';
import { methodAddressesOf, methodListsOf } from '../../control-plane/record-addresses.js';
import { admitEffects } from '../../security/effect-authority.js';
import { daemonCapability, type DaemonCapabilityServices } from '../../capabilities/builtin/index.js';
import type { CapabilityCatalog } from '../../capabilities/catalog.js';
import { findCapabilities } from '../../capabilities/find.js';
import { checkCapabilityInputs } from '../../capabilities/validate.js';
import { pathInputsRefusal } from '../../capabilities/path-inputs.js';
import { methodBodyOf } from '../../capabilities/operator-input.js';
import { CapabilityRefusal } from '../../capabilities/types.js';
import type { Tool } from '../../types/tools.js';
import { capabilityFindDefinition, capabilityRunDefinition } from './definitions.js';
import { createSecretInputProjector, revealSecretInputs } from './secret-inputs.js';
import type { ToolInputProjector } from '../input-projection.js';

export interface DaemonCapabilityToolHost {
  /** The daemon's whole catalog, read once (daemon-catalog.ts). */
  readonly catalog: () => Promise<CapabilityCatalog>;
  /**
   * The same catalog once it has been read, for the definition the gate decides by; undefined before. A
   * registry built before then decides and runs only the moved capabilities and the daemon methods.
   */
  readonly loaded?: (() => CapabilityCatalog | undefined) | undefined;
  readonly services: DaemonCapabilityServices;
  /** The daemon's method catalog, for a method by id and an action with its own method. */
  readonly methods: Pick<GatewayMethodCatalog, 'get' | 'hasHandler' | 'invoke'> & Partial<Pick<GatewayMethodCatalog, 'daemonTurnMethodCall'>>;
  /** The turn's working directory: the project a hooks file or a project secret belongs to. */
  readonly workingDirectory: () => string;
}

function message(error: unknown): string {
  if (error instanceof CapabilityRefusal) return error.next ? `${error.message} ${error.next}.` : error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one line a call naming a capability method itself is refused with: a capability is run by its own id, and a
 * capability call is never wrapped in a method call, where it would be judged as that method instead of as itself.
 */
function capabilityMethodRefusal(id: string): string {
  return id === 'capabilities.run' || id === 'capabilities.find'
    ? `${id} is not run through capability_run: a capability is run by its own id (capability_find gives it), and a capability call is never wrapped in a method call to be judged another way.`
    : `${id} is what this tool calls: name the capability itself (capability_find gives its id).`;
}

/**
 * Who a call of this turn acts as: the model, for whose turn it is (security/turn-session.ts `turnModelActor`): a
 * member's or a device's web chat is that caller's model's turn, whoever sent the message; the owner's is his.
 */
function turnAgent(): Actor {
  return turnModelActor();
}

export interface DaemonCapabilityTools {
  readonly tools: readonly Tool[];
  /** The projector `capability_run` is registered with, which hides its secret inputs. */
  readonly runProjection: ToolInputProjector;
}

export function createDaemonCapabilityTools(host: DaemonCapabilityToolHost, fallback: CapabilityCatalog): DaemonCapabilityTools {
  // The catalog this registry decides by: what the gate's definition knows is all this tool runs. Before the
  // daemon's catalog is read, the moved capabilities and the daemon methods; once it is, the definition is built
  // again from it (the registry takes a replaced definition before the next call it decides).
  let decidedBy = host.loaded?.() ?? fallback;
  const find: Tool = {
    definition: capabilityFindDefinition(),
    async execute(args, options) {
      const need = typeof args.need === 'string' ? args.need.trim() : '';
      if (!need) return { success: false, error: 'Say what you need in words: need is required.' };
      try {
        return { success: true, output: JSON.stringify(await findCapabilities(await host.catalog(), need, options?.signal ? { signal: options.signal } : {}), null, 2) };
      } catch (error) {
        return { success: false, error: message(error) };
      }
    },
  };
  const methods = BUILTIN_GATEWAY_METHODS;
  const methodOf = new Map(methods.map((method) => [method.id, method]));
  const definitionFor = (catalog: CapabilityCatalog) => {
    const entries = catalog.list();
    // An action run through its own method carries that method's declarations under its own id.
    const byMethod = (test: (method: (typeof methods)[number]) => boolean): string[] => [
      ...methods.filter(test).map((method) => method.id),
      ...entries.filter((entry) => entry.method && !daemonCapability(entry.id) && methodOf.get(entry.method.id) && test(methodOf.get(entry.method.id)!)).map((entry) => entry.id),
    ];
    // A method is decided by its risk class (control-plane/method-risk.ts), the ONE owner decision every door applies
    // (daemon/method-owner-decision.ts), never by the older descriptor flags alone: one a model never calls stays refused;
    // the owner's own act is put to him in every mode, opening on No; a loosening or a secret write is his to decide
    // (`loosen-security`), one that cannot be undone `irreversible-operator`; money is decided under the mode in force
    // for the turn's project; what runs by itself later is never made unasked from what the turn read.
    const refused = (method: (typeof methods)[number]): boolean => method.modelRefused === true || method.ownerOnly === true || (method.effects ?? []).includes('model.refused');
    const risk = (method: (typeof methods)[number]) => riskOfDescriptor(method);
    return capabilityRunDefinition(entries, {
      // An answer to something addressed to the owner is never a model's (refused, never asked).
      ownerActs: byMethod((method) => refused(method) || risk(method) === 'owner-act' || risk(method) === 'answers-the-owner'),
      ownerActsAsked: byMethod((method) => !refused(method) && risk(method) === 'owner-act'),
      irreversible: byMethod((method) => method.irreversible === true || risk(method) === 'cannot-be-undone'),
      loosens: byMethod((method) => risk(method) === 'loosens-a-protection' || risk(method) === 'writes-a-secret'),
      runsLater: byMethod((method) => RUNS_LATER_METHOD_IDS.has(method.id)),
      // What spends money: asked each time once the conversation read text from outside (security/conversation-exposure.ts).
      sendsOrSpends: byMethod((method) => risk(method) === 'spends-money'),
      contractChanges: byMethod((method) => method.changesContract === true),
      // A method by id that only reads: class `none` with its declared read effect (and nothing a model never calls, or
      // that runs later), whose answer the one reach rule bounds (control-plane/record-addresses.ts: it lists records of
      // a declared kind, or names one by a declared input): a read to this gate, as a capability that only reads is. A
      // turn on someone else's input reads it within its reach (caller-reach.ts); a read the rule cannot bound (the
      // owner's watchers, his status) stays "would change or start something" to such a turn.
      reads: methods.filter((method) => !refused(method) && risk(method) === 'none' && method.effect === 'read' && !RUNS_LATER_METHOD_IDS.has(method.id)
        && method.irreversible !== true && method.changesContract !== true
        && (methodListsOf(method.id).length > 0 || Object.keys(methodAddressesOf(method.id)).length > 0)).map((method) => method.id),
      recipients: Object.fromEntries(methods.filter((method) => method.recipients && method.recipients.length > 0)
        .map((method) => [method.id, method.recipients!.map((path) => `inputs.${path}`)])),
    });
  };
  /** This turn's project and session, as every method call of it names them (a terminal program's call context). */
  const turnCall = (): { readonly project: string; readonly sessionId?: string; readonly othersInput?: true; readonly othersInputFor?: string } => {
    // Whose turn it is (security/turn-session.ts, the one reader): a web chat's turn names its chat; a run of the daemon's
    // own (a schedule's, a trigger's) has no conversation of its own but the run: its asks and records name the run (the
    // agent's id, the session its questions are raised under).
    const { sessionId } = whoseTurn();
    // A turn on someone else's input reaches only the chats and sessions its own caller made (control-plane/caller-reach.ts).
    const party = turnInputParty();
    const others = party.party === 'other' ? { othersInput: true as const, ...(party.madeFor ? { othersInputFor: party.madeFor } : {}) } : {};
    return { project: host.workingDirectory(), ...(sessionId ? { sessionId } : {}), ...others };
  };
  // The bodies an action's preview read before the gate, each taken once by its call's run (as the daemon's own route).
  const previews = new Map<string, Record<string, unknown>>();
  // Keyed by the turn too: one project's registry serves every daemon turn there, and one turn's preview is never another's
  // body (two turns making the same call each run on the body their own gate was shown).
  const previewKey = (id: string, values: Readonly<Record<string, string>>): string => `${whoseTurn().turnId ?? ''}\u0000${id}\u0000${JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))}`;
  /**
   * An action's preview (a read the daemon answers with the method's body), as this turn: through the daemon's one
   * dispatch when it is there, as the action's method itself goes (a trigger's preview needs the owner's administrative
   * authority his own turn has), else the handler in process.
   */
  const previewAsTurn = (previewId: string, fields: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> => {
    const actor = turnAgent();
    const context = { actor, clientKind: 'daemon-turn', principalId: actor.id, call: turnCall() };
    const dispatch = host.methods.daemonTurnMethodCall?.();
    if (dispatch) return dispatch(previewId, fields, { body: fields, ...(signal ? { signal } : {}), context });
    return host.methods.invoke(previewId, { body: fields, ...(signal ? { signal } : {}), context });
  };
  const run: Tool = {
    definition: definitionFor(decidedBy),
    // What refuses the call without the owner (its id, its inputs, its preview) is read before this turn's gate
    // decides it, in the order capabilities.run reads it for an outside caller: nobody is asked about a call that fails.
    async refuseBeforeGate(args, { signal }) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return 'id is required: a capability id from capability_find, or a daemon method id.';
      if (id.startsWith('capabilities.')) return capabilityMethodRefusal(id);
      const entry = decidedBy.get(id);
      if (!entry) return undefined;
      const secret = entry.inputs.filter((input) => input.kind === 'secret');
      const given: Record<string, unknown> = { ...(args.inputs !== null && typeof args.inputs === 'object' && !Array.isArray(args.inputs) ? args.inputs as Record<string, unknown> : {}) };
      for (const input of secret) if (input.required === true && (typeof given[input.id] !== 'string' || given[input.id] === '')) given[input.id] = '(typed by the person)';
      const checked = checkCapabilityInputs(entry, given);
      if (!checked.ok) return checked.problem;
      // Its preview check (a file outside the project, named by the model): refused before this turn's gate asks anyone.
      // Every file named by path is inside the project first (capabilities/path-inputs.ts).
      const turnCaller = { workingDirectory: host.workingDirectory(), personAsked: false };
      const previewRefusal = pathInputsRefusal(entry, checked.values, turnCaller)
        ?? (entry.home === 'daemon' ? daemonCapability(entry.id)?.check?.(checked.values, turnCaller) : undefined);
      if (previewRefusal) return message(previewRefusal);
      if (entry.home !== 'daemon' || daemonCapability(entry.id) || !entry.method?.preview || secret.length > 0) return undefined;
      const method = entry.method;
      try {
        const body = await methodBodyOf(method, checked.values, (previewId, fields) => previewAsTurn(previewId, fields, signal),
          // What it makes belongs to this turn's project.
          host.workingDirectory());
        previews.set(previewKey(entry.id, checked.values), body);
        while (previews.size > 16) previews.delete(previews.keys().next().value!);
      } catch (error) {
        return message(error);
      }
      return undefined;
    },
    async execute(args, options) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return { success: false, error: 'id is required: a capability id from capability_find, or a daemon method id.' };
      if (id.startsWith('capabilities.')) return { success: false, error: capabilityMethodRefusal(id) };
      const actor = turnAgent();
      // `capabilities.run` is told the call was decided here (the Agent's kind); a method is called as the owner's model
      // without it, so a method the daemon admits natively for the Agent's own credential is not decided a second time:
      // this turn's gate, in this daemon, was the decision (exactly one, at the daemon).
      // The mark is the one `capabilities.run` reads for a call a program's gate decided (routes/capabilities.ts
      // `decidedByProgramGate`); without it the daemon's capability gate asked the owner a second time about a call this
      // turn's gate had already put to him and he had answered (his web chat's hand-over, asked twice).
      // Every call names this turn's project and session, as a terminal program's calls do (its call context): a method
      // routed by project (Work) reaches this project's, a list filtered by project is this project's, and what a call
      // records (a memory, an approval) names the conversation it came from.
      const call = turnCall();
      const sessionId = call?.sessionId;
      const context = { actor, credentialKind: 'agent' as const, clientKind: 'daemon-turn', principalId: actor.id, call, metadata: { decidedByCapabilityGate: true } };
      // The daemon's own turn is the owner's own program (the Agent's kind): the folders and files its method calls name
      // are checked by the method catalog's one check as such (control-plane/caller-paths.ts), as the dispatch's are.
      const methodContext = { actor, credentialKind: 'agent' as const, clientKind: 'daemon-turn', principalId: actor.id, call };
      const callMethod = async (methodId: string, body: Record<string, unknown> | (() => Promise<Record<string, unknown>>)) => {
        const descriptor = host.methods.get(methodId);
        if (!descriptor) return { success: false, error: `No capability or daemon method named ${id}. capability_find says what each capability is called.` };
        // The daemon's one dispatch, as a capability's nested method goes (daemon/capability-wiring.ts): the owner's own
        // turn acts with his authority there (a schedule, a trigger, a watcher, a task in its project), a method served
        // only by its route is reached through it, and the folder and reach checks are the dispatch's. This turn's gate
        // was the one decision; the dispatch does not decide it again. Without it (a registry built outside a daemon), a
        // method's handler in process.
        const dispatch = host.methods.daemonTurnMethodCall?.();
        if (!dispatch && !host.methods.hasHandler(methodId)) return { success: false, error: `${methodId} is served over the daemon's HTTP route only and cannot be called from this turn.` };
        // What the method declares it causes, admitted for the owner's model, as the request path admits it.
        const admission = admitEffects(actor, descriptor.effects ?? []);
        if (admission.kind !== 'allowed') return { success: false, error: `${methodId} was not run: ${admission.reason}.${'next' in admission && admission.next ? ` ${admission.next}` : ''}` };
        try {
          const sent = typeof body === 'function' ? await body() : body;
          if (dispatch) {
            // In process, with no credential: the dispatch sends it with the daemon's own for this turn's actor.
            const turnInvocation = { body: sent, ...(options?.signal ? { signal: options.signal } : {}),
              context: { actor, clientKind: 'daemon-turn', principalId: actor.id, call } };
            const answer = await dispatch(methodId, sent, turnInvocation) as { readonly ok?: unknown; readonly code?: unknown; readonly state?: unknown } | null;
            // A call the dispatch put to the owner answers with its state ("... is waiting for the owner"), never "done".
            if (answer !== null && typeof answer === 'object' && answer.ok === false && answer.code === 'OWNER_APPROVAL_PENDING') {
              return { success: false, error: typeof answer.state === 'string' && answer.state ? answer.state : `${methodId}: waiting for the owner; nothing ran yet.` };
            }
            return { success: true, output: JSON.stringify(answer ?? null, null, 2) };
          }
          // The owner's own turn uses his Work by a method's id as through a capability: with his local authority
          // (control-plane/owner-work-method.ts, as daemon/capability-wiring.ts sends a nested Work method).
          const ownersWork = isOwnerWorkMethod(methodId) && turnInputParty().party === 'owner';
          const answer = await host.methods.invoke(methodId, { body: sent, ...(options?.signal ? { signal: options.signal } : {}),
            context: ownersWork ? { ...methodContext, admin: true, scopes: ['*'] } : methodContext });
          return { success: true, output: JSON.stringify(answer ?? null, null, 2) };
        } catch (error) {
          return { success: false, error: message(error) };
        }
      };
      const inputs = revealSecretInputs(options?.inputProjectionContext, args);
      const entry = decidedBy.get(id);
      if (!entry) {
        // Only what the gate's definition knew: a capability read after this registry was built is not run unjudged.
        if ((await host.catalog()).get(id)) return { success: false, error: `${id} was not yet known when this call was decided, so nothing ran; call it again.` };
        return callMethod(id, inputs);
      }
      const checked = checkCapabilityInputs(entry, inputs);
      if (!checked.ok) return { success: false, error: checked.problem };
      if (entry.home === 'session') return { success: false, error: `${entry.id} acts on a terminal program's open conversation; this turn is the daemon's own and has none.` };
      // A moved capability, or one whose method is served over the daemon's HTTP route only (no handler to call here):
      // through the daemon's own `capabilities.run`, which reaches that route with the daemon's own credential for this
      // turn's actor (daemon/capability-wiring.ts `invokeMethod`, `daemonTurn`), as a terminal program's model reaches it.
      if (daemonCapability(entry.id) || (entry.method !== undefined && !host.methods.hasHandler(entry.method.id))) {
        try {
          // Its effects are admitted there for this actor; this call was decided here already.
          const answer = await host.methods.invoke(CAPABILITY_RUN_METHOD_ID, {
            body: { id: entry.id, inputs: checked.values, workingDirectory: host.workingDirectory(), ...(sessionId ? { sessionId } : {}) },
            ...(options?.signal ? { signal: options.signal } : {}), context,
          }) as { readonly text?: unknown; readonly ok?: unknown; readonly state?: unknown } | null;
          // A call held for the owner answers with its state ("... is waiting for the owner: nothing ran yet"), never "done".
          if (answer?.ok === false) return { success: false, error: typeof answer.state === 'string' && answer.state ? answer.state : `${entry.label}: not run.` };
          return { success: true, output: typeof answer?.text === 'string' && answer.text ? answer.text : `${entry.label}: done.` };
        } catch (error) {
          return { success: false, error: message(error) };
        }
      }
      if (entry.method) {
        const method = entry.method;
        // The preview (a read) first when the action has one: its answer is the method's body, as read before the gate.
        const key = previewKey(entry.id, checked.values);
        const read = previews.get(key);
        previews.delete(key);
        return callMethod(method.id, read ? read : () => methodBodyOf(method, checked.values, (previewId, fields) =>
          previewAsTurn(previewId, fields, options?.signal), host.workingDirectory()));
      }
      return { success: false, error: `${entry.id} (/${entry.command}${entry.word ? ` ${entry.word}` : ''}) runs only inside a terminal program for now.` };
    },
  };
  if (!host.loaded?.()) {
    // Read off the start path; a call decided before it lands runs only what the first definition knew.
    void host.catalog().then((catalog) => {
      decidedBy = catalog;
      run.definition = definitionFor(catalog);
    }).catch(() => { /* the moved capabilities and the daemon methods stay what this tool decides and runs */ });
  }
  const runProjection = createSecretInputProjector((capabilityId, given) => (decidedBy.get(capabilityId)?.inputs ?? [])
    .filter((input) => input.kind === 'secret' && input.plainWhen?.(given) !== true).map((input) => input.id));
  return { tools: [find, run], runProjection };
}

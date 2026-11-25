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
import { agentActor, localOwnerActor, type Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { currentTurn } from '../../security/turn-boundary.js';
import { admitEffects } from '../../security/effect-authority.js';
import { daemonCapability, type DaemonCapabilityServices } from '../../capabilities/builtin/index.js';
import type { CapabilityCatalog } from '../../capabilities/catalog.js';
import { findCapabilities } from '../../capabilities/find.js';
import { checkCapabilityInputs } from '../../capabilities/validate.js';
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
  readonly methods: Pick<GatewayMethodCatalog, 'get' | 'hasHandler' | 'invoke'>;
  /** The turn's working directory: the project a hooks file or a project secret belongs to. */
  readonly workingDirectory: () => string;
}

function message(error: unknown): string {
  if (error instanceof CapabilityRefusal) return error.next ? `${error.message} ${error.next}.` : error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Who a call of this turn acts as: the model, for the turn's owner. */
function turnAgent(): Actor {
  return agentActor(currentTurn()?.actor ?? localOwnerActor());
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
    return capabilityRunDefinition(entries, {
      ownerActs: byMethod((method) => method.modelRefused === true || method.ownerOnly === true || (method.effects ?? []).includes('model.refused')),
      irreversible: byMethod((method) => method.irreversible === true),
      contractChanges: byMethod((method) => method.changesContract === true),
      recipients: Object.fromEntries(methods.filter((method) => method.recipients && method.recipients.length > 0)
        .map((method) => [method.id, method.recipients!.map((path) => `inputs.${path}`)])),
    });
  };
  const run: Tool = {
    definition: definitionFor(decidedBy),
    async execute(args, options) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return { success: false, error: 'id is required: a capability id from capability_find, or a daemon method id.' };
      if (id.startsWith('capabilities.')) return { success: false, error: `${id} is what this tool calls: name the capability itself (capability_find gives its id).` };
      const actor = turnAgent();
      // `capabilities.run` is told the call was decided here (the Agent's kind); a method is called as the owner's model
      // without it, so a method the daemon admits natively for the Agent's own credential is not decided a second time:
      // this turn's gate, in this daemon, was the decision (exactly one, at the daemon).
      const context = { actor, credentialKind: 'agent' as const, clientKind: 'daemon-turn', principalId: actor.id };
      const methodContext = { actor, clientKind: 'daemon-turn', principalId: actor.id };
      const callMethod = async (methodId: string, body: Record<string, unknown> | (() => Promise<Record<string, unknown>>)) => {
        const descriptor = host.methods.get(methodId);
        if (!descriptor) return { success: false, error: `No capability or daemon method named ${id}. capability_find says what each capability is called.` };
        if (!host.methods.hasHandler(methodId)) return { success: false, error: `${methodId} is served over the daemon's HTTP route only and cannot be called from this turn.` };
        // What the method declares it causes, admitted for the owner's model, as the request path admits it.
        const admission = admitEffects(actor, descriptor.effects ?? []);
        if (admission.kind !== 'allowed') return { success: false, error: `${methodId} was not run: ${admission.reason}.${'next' in admission && admission.next ? ` ${admission.next}` : ''}` };
        try {
          const sent = typeof body === 'function' ? await body() : body;
          const answer = await host.methods.invoke(methodId, { body: sent, ...(options?.signal ? { signal: options.signal } : {}), context: methodContext });
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
      if (daemonCapability(entry.id)) {
        try {
          // Its effects are admitted there for this actor; this call was decided here already.
          const answer = await host.methods.invoke(CAPABILITY_RUN_METHOD_ID, {
            body: { id: entry.id, inputs: checked.values, workingDirectory: host.workingDirectory() },
            ...(options?.signal ? { signal: options.signal } : {}), context,
          }) as { readonly text?: unknown } | null;
          return { success: true, output: typeof answer?.text === 'string' && answer.text ? answer.text : `${entry.label}: done.` };
        } catch (error) {
          return { success: false, error: message(error) };
        }
      }
      if (entry.method) {
        const method = entry.method;
        // The preview (a read) first when the action has one: its answer is the method's body.
        return callMethod(method.id, () => methodBodyOf(method, checked.values, (previewId, fields) =>
          host.methods.invoke(previewId, { body: fields, ...(options?.signal ? { signal: options.signal } : {}), context: methodContext })));
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
  const runProjection = createSecretInputProjector((capabilityId) => (decidedBy.get(capabilityId)?.inputs ?? [])
    .filter((input) => input.kind === 'secret').map((input) => input.id));
  return { tools: [find, run], runProjection };
}

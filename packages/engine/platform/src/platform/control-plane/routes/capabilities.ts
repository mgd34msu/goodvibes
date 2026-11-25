/**
 * routes/capabilities.ts, the handlers of `capabilities.find` and
 * `capabilities.run` (method-catalog-capabilities.ts).
 *
 * Run, in order: the capability by id; where it runs (a conversation's
 * capability, or one not moved yet, is refused with where it does run); the
 * inputs against its definition; its effects admitted for the caller (the
 * same table every method is held to); then who asked decides whether it is
 * put to the owner: a person's own request (the claim the daemon keeps only
 * from a person's credential) and a call the Agent makes after its own gate
 * admitted it run at once; any other caller's call goes through this
 * daemon's permission gate under the owner's mode. A capability with its own
 * method runs through that method, as the same caller.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { attachHandler } from './attach-handler.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { admitEffects } from '../../security/effect-authority.js';
import { systemActor } from '@goodvibes/engine/daemon-api/http-policy';
import { randomUUID } from 'node:crypto';
import { withUntrustedContentScope } from '../../security/untrusted-content.js';
import { capabilityEffects, effectiveRisk, OWNER_DECIDED_EFFECTS, type CapabilityCatalog, type CapabilityEntry } from '../../capabilities/catalog.js';
import { findCapabilities } from '../../capabilities/find.js';
import { checkCapabilityInputs } from '../../capabilities/validate.js';
import { capabilityOutcomeText } from '../../capabilities/outcome.js';
import { methodBodyOf } from '../../capabilities/operator-input.js';
import { daemonCapability, methodCapability, type DaemonCapabilityServices } from '../../capabilities/builtin/index.js';
import { CapabilityRefusal, type CapabilityCaller } from '../../capabilities/types.js';
export interface CapabilityGateRequest {
  readonly entry: CapabilityEntry;
  readonly values: Readonly<Record<string, string>>;
  readonly caller: CapabilityCaller;
  readonly signal?: AbortSignal | undefined;
}

export interface CapabilityRouteDeps {
  readonly catalog: () => Promise<CapabilityCatalog>;
  readonly services: DaemonCapabilityServices;
  /** Run another method as the same caller (its own admission and confirmation gate apply), answering its body or throwing its refusal. */
  readonly invokeMethod: (methodId: string, body: Record<string, unknown>, invocation: GatewayMethodInvocation) => Promise<unknown>;
  /**
   * This daemon's permission gate under the owner's mode, for a caller that is
   * neither a person asking nor the Agent after its own gate. Absent: such a
   * call runs only when it carries no risk and only reads.
   */
  readonly gate?: ((request: CapabilityGateRequest) => Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>) | undefined;
}

function personAsked(invocation: GatewayMethodInvocation): boolean {
  return invocation.context.metadata?.['explicitUserRequest'] === true;
}

function callerOf(params: Record<string, unknown>): CapabilityCaller {
  const workingDirectory = typeof params['workingDirectory'] === 'string' && params['workingDirectory'].trim() ? params['workingDirectory'].trim() : undefined;
  const program = params['program'] === 'tui' || params['program'] === 'agent' ? params['program'] : undefined;
  // The model of the asking program's conversation (a context window size acts on it unless the call names another).
  const model = typeof params['model'] === 'string' && params['model'].trim() ? params['model'].trim() : undefined;
  return { ...(workingDirectory ? { workingDirectory } : {}), ...(program ? { program } : {}), ...(model ? { model } : {}) };
}

function where(entry: CapabilityEntry): string {
  const line = `/${entry.command}${entry.word ? ` ${entry.word}` : ''}`;
  return entry.home === 'session'
    // A session capability may have no slash command any more: it is named by where it is, never by a line to type.
    ? `${entry.id} acts on what a terminal program holds (its conversation, its screen or its own records), so it runs in that program (its place there, or capability_run from its model); nothing ran here.`
    : `${entry.id} has not moved to the daemon yet: it runs only inside a terminal program (${line} there, or capability_run from its model); nothing ran here.`;
}

function createRunHandler(deps: CapabilityRouteDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const id = typeof params['id'] === 'string' ? params['id'].trim() : '';
    const catalog = await deps.catalog();
    const entry = id ? catalog.get(id) : undefined;
    if (!entry) throw new GatewayVerbError(`No capability ${id || '(no id given)'}.`, 'CAPABILITY_NOT_FOUND', 404, 'id', { next: ['Say what you need to capabilities.find; it names the capabilities that do it.'] });
    if (entry.home !== 'daemon') throw new GatewayVerbError(where(entry), 'CAPABILITY_ELSEWHERE', 409, 'id', {
      next: [entry.home === 'session' ? 'Run it in the terminal app or the Agent, from its place there.' : `Run it in the terminal app or the Agent: /${entry.command}${entry.word ? ` ${entry.word}` : ''}.`],
    });
    const checked = checkCapabilityInputs(entry, params['inputs']);
    if (!checked.ok) throw new GatewayVerbError(checked.problem, 'CAPABILITY_INPUT_INVALID', 400, checked.input ? `inputs.${checked.input}` : 'inputs', { next: ['capabilities.find lists each input with its kind and choices.'] });
    const values = checked.values;
    const caller = callerOf(params);
    const risk = effectiveRisk(entry, values);
    const definition = daemonCapability(entry.id);
    // A capability with its own method is admitted by that method; a moved one by its own effects.
    if (definition) {
      const actor = invocation.context.actor ?? systemActor('in-process');
      const effects = capabilityEffects(entry, values);
      // A model's call that arrives through capability_run (the Agent's kind, after the program's or the turn's gate)
      // was put to the owner for what it writes: writing a credential is admitted as his, not refused as the model's.
      // The effect table's refusal (security/effect-authority.ts, `secret.write`) stands for every other path.
      const ownerDecided = invocation.context.credentialKind === 'agent' && actor.agentFor !== undefined;
      const asModel = ownerDecided ? effects.filter((effect) => !OWNER_DECIDED_EFFECTS.has(effect)) : effects;
      const asOwner = ownerDecided ? effects.filter((effect) => OWNER_DECIDED_EFFECTS.has(effect)) : [];
      const modelAdmission = admitEffects(actor, asModel);
      const admission = modelAdmission.kind !== 'allowed' || asOwner.length === 0 ? modelAdmission : admitEffects(actor.agentFor!, asOwner);
      if (admission.kind === 'refused') throw new GatewayVerbError(`${entry.id}: ${admission.reason}. ${admission.next}`, admission.code, 403);
      if (admission.kind === 'ask-owner') throw new GatewayVerbError(`${entry.id} is the owner's to decide (${admission.reason}).`, 'OWNER_ONLY', 403);
    }
    const admittedElsewhere = personAsked(invocation) || invocation.context.credentialKind === 'agent';
    if (!admittedElsewhere) {
      if (deps.gate) {
        // The gate's check reads the untrusted-content window of the scope it runs in and fails if that window moves
        // while the owner is being asked. Over HTTP the call's scope is its principal's, and the owner's answer from
        // the same credential, as a person's request, starts a new turn in exactly that scope: the check then failed
        // with "untrusted content evidence changed during comparison" and the approved call never ran. The call is a
        // request over the wire with nothing it read in this daemon, so it is decided in a window of its own, which
        // only this call can move.
        const decided = await withUntrustedContentScope(`capability-run:${randomUUID()}`,
          () => deps.gate!({ entry, values, caller, ...(invocation.signal ? { signal: invocation.signal } : {}) }));
        if (!decided.approved) throw new GatewayVerbError(`${entry.id} was not run: ${decided.reason ?? 'the owner did not approve it'}.`, 'CAPABILITY_NOT_APPROVED', 403);
      } else if (risk !== 'none' || entry.touches !== 'reads') {
        throw new GatewayVerbError(`${entry.id} was not run: it changes something, and nobody here can be asked under your mode.`, 'CAPABILITY_NOT_APPROVED', 403);
      }
    }
    if (definition) {
      try {
        // A handler whose act a daemon method does calls that method as this same caller.
        const result = await definition.run(values, deps.services, {
          ...caller, personAsked: personAsked(invocation),
          method: (methodId, body) => deps.invokeMethod(methodId, body, invocation),
        });
        // A value the person must see once is returned only to the person who asked (a key pressed, a form submitted,
        // a line typed); any other caller is told where he sees it, and never gets it.
        const reveal = definition.reveals && result.reveal ? { ...definition.reveals, ...result.reveal } : undefined;
        const toPerson = reveal !== undefined && personAsked(invocation);
        const withheld = reveal && !toPerson ? ` The ${definition.reveals!.label.toLowerCase()} is shown only to the owner, when he asks for it himself.` : '';
        return {
          id: entry.id, ok: true, text: `${capabilityOutcomeText(entry, values, result)}${withheld}`, detail: `${result.text}${withheld}`, risk,
          ...(result.data ? { data: result.data } : {}), ...(toPerson ? { reveal } : {}), repeat: definition.capability.repeat,
        };
      } catch (error) {
        if (error instanceof CapabilityRefusal) throw new GatewayVerbError(error.message, 'CAPABILITY_REFUSED', 422, undefined, { next: error.next ? [error.next] : [] });
        throw error;
      }
    }
    if (!entry.method) throw new GatewayVerbError(where(entry), 'CAPABILITY_ELSEWHERE', 409, 'id');
    let input: Record<string, unknown>;
    try {
      // An action with a preview sends the body its preview reads from the values (the web UI's sheet does the same).
      input = await methodBodyOf(entry.method, values, (previewId, fields) => deps.invokeMethod(previewId, fields, invocation));
    } catch (error) {
      if (error instanceof CapabilityRefusal) throw new GatewayVerbError(error.message, 'CAPABILITY_REFUSED', 422);
      throw error;
    }
    const body = await deps.invokeMethod(entry.method.id, input, invocation);
    const data = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : { result: body };
    // A method capability's own words for what ran and how it came out (builtin/method-capability.ts `said`).
    let detail = '';
    try { detail = methodCapability(entry.id)?.said?.(data, values) ?? ''; } catch { detail = ''; }
    // What this run did about what its risk names, when not every run does it (builtin/method-capability.ts `did`).
    let did: string | undefined;
    try { did = methodCapability(entry.id)?.did?.(data, values); } catch { did = undefined; }
    const text = capabilityOutcomeText(entry, values, { text: detail, ...(did !== undefined ? { riskDone: did } : {}) });
    return {
      id: entry.id, ok: true, text: text || `${entry.label}: done.`, ...(detail ? { detail } : {}), risk, method: entry.method.id,
      data,
    };
  };
}

function createFindHandler(deps: CapabilityRouteDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const need = typeof params['need'] === 'string' ? params['need'].trim() : '';
    if (!need) throw new GatewayVerbError('Say what you need in words: need is required.', 'CAPABILITY_INPUT_INVALID', 400, 'need');
    const catalog = await deps.catalog();
    const found = await findCapabilities(catalog, need, invocation.signal ? { signal: invocation.signal } : {});
    return {
      ...found,
      capabilities: found.capabilities.map((capability) => {
        const repeat = daemonCapability(capability.id)?.capability.repeat ?? catalog.get(capability.id)?.repeat;
        return repeat ? { ...capability, repeat } : capability;
      }),
    };
  };
}

export function registerCapabilityGatewayMethods(catalog: GatewayMethodCatalog, deps: CapabilityRouteDeps): void {
  attachHandler(catalog, 'capabilities.find', createFindHandler(deps));
  attachHandler(catalog, 'capabilities.run', createRunHandler(deps));
}

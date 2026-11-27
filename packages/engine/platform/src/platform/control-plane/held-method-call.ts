/**
 * held-method-call.ts, a daemon method call the dispatch put to the owner (daemon/method-owner-decision.ts), as
 * `capabilities.run` decides and keeps it (routes/capabilities.ts): one capability entry made from the method's own
 * descriptor, so the owner's gate decides it exactly as the capability that does the same act (its class is the
 * entry's risk; an act of his own is his `owner-act`; a write of a secret is `secret.write`, a loosening, whose
 * value is never written on the question), the card names it by the method's title, and what came of it is kept with
 * the question like any held capability call. The call itself, its body and query, travels as one input (`request`,
 * JSON), never read as a capability's fields: on the owner's yes it is sent again as it came.
 *
 * Made only from the dispatch's own metadata (`methodCall`, never a caller's body), or from a question this daemon's
 * gate raised before a restart. Pure: no I/O.
 */
import type { CapabilityEntry } from '../capabilities/catalog.js';
import type { ActionRisk, InputDescription } from '../capabilities/types.js';
import type { EffectId } from '../security/effect-authority.js';
import { methodCallRisk, type MethodRisk } from './method-risk.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { OUTSIDE_AGENT_ISSUE_METHOD_ID, outsideAgentQuestion } from './method-catalog-programs.js';

/** The one input a held method call carries: its body and query, as JSON. */
export const HELD_METHOD_INPUT = 'request';

/** What the dispatch hands `capabilities.run` for a call it put to the owner (in process only). */
export interface HeldMethodCall {
  readonly id: string;
  readonly body: unknown;
  readonly query: Record<string, unknown>;
}

/** The held call as `capabilities.run` decides it: its entry, its one input's value, and its class. */
export interface HeldMethodCallEntry {
  readonly entry: CapabilityEntry;
  readonly values: Readonly<Record<string, string>>;
  readonly risk: MethodRisk;
  readonly call: HeldMethodCall;
}

const ACTION_RISK: Readonly<Record<MethodRisk, ActionRisk>> = {
  // What steers a model is decided under the owner's mode, as a capability that declares `steersModel`.
  'none': 'none', 'loosens-a-protection': 'loosens-a-protection', 'steers-a-model': 'none', 'cannot-be-undone': 'cannot-be-undone',
  'spends-money': 'spends-money', 'writes-a-secret': 'none', 'owner-act': 'none',
  // Never held (an answer is answered or refused, method-owner-decision.ts); listed so every class has its line.
  'answers-the-owner': 'none',
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The dispatch's held call from an invocation's metadata, or undefined (anything a caller sent is never one). */
export function heldMethodCallOf(metadata: Readonly<Record<string, unknown>> | undefined): HeldMethodCall | undefined {
  const kept = recordOf(metadata?.['methodCall']);
  if (!kept || typeof kept['id'] !== 'string' || !kept['id']) return undefined;
  return { id: kept['id'], body: kept['body'] ?? {}, query: recordOf(kept['query']) ?? {} };
}

/** The held call kept on a question (its one input's JSON), read back after a restart; undefined when it cannot be. */
export function heldMethodCallFromValues(id: string, values: Readonly<Record<string, unknown>> | undefined): HeldMethodCall | undefined {
  const raw = values?.[HELD_METHOD_INPUT];
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = recordOf(JSON.parse(raw));
    if (!parsed) return undefined;
    return { id, body: parsed['body'] ?? {}, query: recordOf(parsed['query']) ?? {} };
  } catch {
    return undefined;
  }
}

/** The input a held secret write shows beside its hidden call: which secret it writes, and where it is kept. */
export const HELD_SECRET_NAMED_INPUT = 'which';

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Which secret a write of one names, and where it will be kept, in words: its key, provider, domain or card label as the
 * call names them, never a value (the card shows these; the call itself stays hidden).
 */
export function secretWriteWords(methodId: string, body: unknown): string {
  const fields = recordOf(body) ?? {};
  const store = 'kept in the daemon\'s encrypted secret store';
  switch (methodId) {
    case 'credentials.set':
      return `the credential of the setting ${text(fields['key']) ?? '(no key named)'}, ${store}, filed under that setting`;
    case 'providers.apiKey.set':
      return `the API key of the provider ${text(fields['provider']) ?? '(no provider named)'}, ${store} under that provider's key name`;
    case 'secureAddress.set': {
      const domain = text(fields['domain']);
      const token = text(fields['cloudflareToken']) !== undefined;
      return `${token ? `a Cloudflare token${domain ? ` for ${domain}` : ''}, ${store}, with ` : ''}the secure address set to ${text(fields['certificate']) ?? '(none named)'}${domain && !token ? ` for ${domain}` : ''}`;
    }
    case 'stepup.credentials.register':
      return `a step-up passkey ${text(fields['label']) ?? text(fields['credentialId']) ?? '(unnamed)'} for ${text(fields['rpId']) ?? '(no site named)'}, kept in the daemon's step-up credentials`;
    case 'payments.cards.create':
      return `the ${text(fields['kind']) ?? ''} card "${text(fields['label']) ?? '(no label)'}", its number, expiry, security code and name ${store}`.replace(/\s+/g, ' ');
    default:
      // Another method's secret write: the names of what it sends, never their values.
      return `what it sends under ${Object.keys(fields).sort().join(', ') || '(nothing named)'}, ${store}`;
  }
}

/**
 * The project a held method call is about, read from the call kept in its one input: the folder the outside agent's
 * credential is asked for (`project`), else the body's `workingDirectory`. Undefined for a call that names none. The
 * owner's question is decided for it and names it as its place, never the daemon's own folder.
 */
export function heldMethodCallProject(methodId: string, values: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const call = heldMethodCallFromValues(methodId, values);
  const body = recordOf(call?.body);
  const named = methodId === OUTSIDE_AGENT_ISSUE_METHOD_ID ? body?.['project'] : body?.['workingDirectory'];
  return typeof named === 'string' && named.trim() ? named.trim() : undefined;
}

/** The capability entry the owner's gate decides a held method call as. */
export function heldMethodCallEntry(descriptor: GatewayMethodDescriptor, call: HeldMethodCall): HeldMethodCallEntry {
  const risk = methodCallRisk(descriptor, call.body);
  const secret = risk === 'writes-a-secret';
  const input: InputDescription = {
    id: HELD_METHOD_INPUT, label: 'What it sends', help: 'The call as it was sent: its body and query', kind: secret ? 'secret' : 'text',
    freeTextReason: 'the method call as its caller sent it', required: true, typed: { tail: true },
  };
  // A secret write's card names WHICH secret and where it is kept; only the value (the whole call) stays hidden.
  const named: InputDescription = {
    id: HELD_SECRET_NAMED_INPUT, label: 'Which secret', help: 'The secret this writes and where it is kept, never its value', kind: 'text',
    freeTextReason: 'words the daemon wrote from the names in the call', required: true, typed: { tail: true },
  };
  const effects: EffectId[] = [...(descriptor.effects ?? ['control-plane.write'])];
  if (secret && !effects.includes('secret.write')) effects.push('secret.write');
  // The outside agent's credential is ONE question, naming the project it was started in (daemon/outside-agent.ts).
  const issueProject = descriptor.id === OUTSIDE_AGENT_ISSUE_METHOD_ID && typeof (call.body as Record<string, unknown> | null)?.['project'] === 'string'
    ? String((call.body as Record<string, unknown>)['project']).trim() || undefined : undefined;
  const label = descriptor.id === OUTSIDE_AGENT_ISSUE_METHOD_ID ? outsideAgentQuestion(issueProject) : descriptor.title;
  const entry: CapabilityEntry = {
    id: descriptor.id, group: 'system', home: 'daemon', command: '', commandTitle: label, actionId: descriptor.id, word: '',
    label, sentence: descriptor.id === OUTSIDE_AGENT_ISSUE_METHOD_ID
      ? `On your yes it has a credential of its own (a paired device you revoke in Devices and network)${issueProject !== undefined ? ` and may work in ${issueProject}; nothing else is given` : ', for shared things only'}.`
      : descriptor.description, done: '', risk: ACTION_RISK[risk],
    touches: secret ? 'credential' : 'this-machine', lasts: 'not-a-change',
    ...(risk === 'owner-act' ? { ownerOnly: { reason: 'it is an act only the owner makes', instead: 'Ask the owner to do it from his own app.' } } : {}),
    effects, inputs: secret ? [named, input] : [input], method: { id: descriptor.id, fields: {} },
  };
  return { entry, values: { ...(secret ? { [HELD_SECRET_NAMED_INPUT]: secretWriteWords(descriptor.id, call.body) } : {}),
    [HELD_METHOD_INPUT]: JSON.stringify({ body: call.body, query: call.query }) }, risk, call };
}

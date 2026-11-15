import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-api';
import { readBrowserDecisionPolicy, runBrowserJudgment } from './goodvibes';
import { DecisionModelsDisabledError } from '@goodvibes-jev/engine/platform/browser/decision-policy';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from './client-lifetime';
import { randomUuid } from './uuid';
import { readReplySubjectMarker } from '@goodvibes-jev/engine/platform/platform/judgment-browser/catalogs';

type Request = BrowserJudgmentRequest<'webui.mail.reply-subject'>;
export type MailReplySubjectResult =
  | { readonly status: 'ready'; readonly alreadyReply: boolean; readonly provenance?: 'rule' | 'classic'; readonly isCurrent: () => boolean }
  | { readonly status: 'held' | 'unavailable' };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** A value-only decision cannot replace or invent any part of the original subject. */
export function readMailReplySubjectResponse(request: Request, raw: unknown): { readonly status: 'ready'; readonly alreadyReply: boolean } | { readonly status: 'held' } | undefined {
  const result = object(raw);
  if (result?.protocolVersion !== 1 || result.batteryVersion !== 1 || result.battery !== request.battery
    || result.requestId !== request.requestId || (result.status !== 'settled' && result.status !== 'held')) return undefined;
  const settled = result.status === 'settled';
  if (!keys(result, ['protocolVersion', 'batteryVersion', 'requestId', 'battery', 'status', settled ? 'value' : 'reason', 'readings', 'outcome', 'evidence'])) return undefined;
  const readings = object(result.readings);
  const reading = object(readings?.already_reply);
  if (!readings || !keys(readings, ['already_reply']) || !reading || !keys(reading, ['kind', 'probability', 'verdict', 'outcome'])
    || reading.kind !== 'yes-no' || !nonnegative(reading.probability) || reading.probability > 1
    || !['yes', 'no', 'uncertain'].includes(String(reading.verdict)) || !['act', 'confirm', 'escalate'].includes(String(reading.outcome))
    || result.outcome !== reading.outcome) return undefined;
  if (!Array.isArray(result.evidence) || result.evidence.length !== 1) return undefined;
  const evidence = object(result.evidence[0]);
  const usage = object(evidence?.usage);
  if (!evidence || !keys(evidence, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs']) || !nonempty(evidence.decisionId)
    || !nonempty(evidence.model) || !nonempty(evidence.requestedModel) || !nonnegative(evidence.latencyMs)
    || !usage || !keys(usage, ['inputTokens', 'outputTokens']) || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens)) return undefined;
  if (!settled) return result.reason === 'uncertain' && reading.outcome !== 'act' ? { status: 'held' } : undefined;
  const value = object(result.value);
  if (!value || !keys(value, ['alreadyReply']) || typeof value.alreadyReply !== 'boolean' || reading.outcome !== 'act'
    || reading.verdict === 'uncertain' || value.alreadyReply !== (reading.verdict === 'yes')) return undefined;
  return { status: 'ready', alreadyReply: value.alreadyReply };
}

/** The longest a Reply click waits for a reading before the rule's answer is used. */
const READING_DEADLINE_MS = 1_500;

/**
 * The reply-marker rule decides the subject at once. Only a short prefix the rule does not know
 * ("Ynt: Lunch") asks the decision model, as advice bounded by the deadline; when the model is off,
 * unsure, slow or unreachable the rule's answer (prepend "Re:") stands, so the draft is never held.
 */
export async function readMailReplySubject(subjectRef: string | undefined, signal: AbortSignal, originalSubject?: string): Promise<MailReplySubjectResult> {
  if (signal.aborted || typeof originalSubject !== 'string' || originalSubject.length > 32768) return { status: 'held' };
  const lifetime = getClientLifetime();
  const isCurrent = () => !signal.aborted && isClientLifetimeCurrent(lifetime);
  const marker = readReplySubjectMarker(originalSubject);
  const byRule = (provenance: 'rule' | 'classic'): MailReplySubjectResult => isCurrent()
    ? { status: 'ready', provenance, alreadyReply: marker === 'reply', isCurrent }
    : { status: 'unavailable' };
  if (marker !== 'unrecognised-prefix' || !subjectRef || subjectRef.length > 256) return byRule('rule');
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const deadline = setTimeout(cancel, READING_DEADLINE_MS);
  try {
    if ((await readBrowserDecisionPolicy(abort.signal)).operation === 'classic') return byRule('classic');
    const request: Request = { protocolVersion: 1, requestId: randomUuid(), battery: 'webui.mail.reply-subject', batteryVersion: 1, input: { subjectRef } };
    const raw = await runBrowserJudgment(request, abort.signal);
    const result = readMailReplySubjectResponse(request, raw);
    return result?.status === 'ready' && isCurrent() ? { ...result, isCurrent } : byRule('rule');
  } catch (error) { return byRule(error instanceof DecisionModelsDisabledError ? 'classic' : 'rule'); }
  finally { clearTimeout(deadline); unsubscribe(); signal.removeEventListener('abort', cancel); }
}

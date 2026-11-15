import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-api';
import { readBrowserDecisionPolicy, runBrowserJudgment } from './goodvibes';
import { DecisionModelsDisabledError } from '@goodvibes-jev/engine/platform/browser/decision-policy';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from './client-lifetime';
import { randomUuid } from './uuid';
import { readBrowserJudgment } from './browser-judgment-reader';
import { readReplySubjectMarker } from '@goodvibes-jev/engine/platform/platform/judgment-browser/catalogs';

type Request = BrowserJudgmentRequest<'webui.mail.reply-subject'>;
export type MailReplySubjectResult =
  | { readonly status: 'ready'; readonly alreadyReply: boolean; readonly provenance?: 'rule' | 'classic'; readonly isCurrent: () => boolean }
  | { readonly status: 'held' | 'unavailable' };

/** A value-only decision cannot replace or invent any part of the original subject. */
export function readMailReplySubjectResponse(request: Request, raw: unknown): { readonly status: 'ready'; readonly alreadyReply: boolean } | { readonly status: 'held' } | undefined {
  const reading = readBrowserJudgment<'webui.mail.reply-subject'>(request, raw);
  if (reading?.status === 'held') return reading;
  return reading && typeof reading.value.alreadyReply === 'boolean' ? { status: 'ready', alreadyReply: reading.value.alreadyReply } : undefined;
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

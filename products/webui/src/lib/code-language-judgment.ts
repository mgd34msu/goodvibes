import { WEBUI_CODE_LANGUAGES, type WebuiCodeLanguage } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { captureChoiceAnswer } from '@goodvibes-jev/judgment/decisions';
import { runBrowserJudgment } from './goodvibes';
import { DecisionModelsDisabledError } from '@goodvibes-jev/engine/sdk/browser/decision-policy';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from './client-lifetime';
import { randomUuid } from './uuid';

type Request = BrowserJudgmentRequest<'webui.code.language'>;
export type CodeSource = { readonly sessionId: string; readonly messageId: string; readonly contentRevision: string; readonly content: string; readonly start: number; readonly end: number };
export type CodeLanguageResult = { readonly status: 'ready'; readonly language: WebuiCodeLanguage; readonly provenance?: 'classic'; readonly isCurrent: () => boolean } | { readonly status: 'held' | 'unavailable' };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const probability = (value: unknown): value is number => nonnegative(value) && value <= 1;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Bind the complete evidence and closed choice to this request, never accept a value-only response. */
export function readCodeLanguageResponse(request: Request, raw: unknown): { readonly status: 'ready'; readonly language: WebuiCodeLanguage } | { readonly status: 'held' } | undefined {
  const result = object(raw);
  if (result?.protocolVersion !== 1 || result.batteryVersion !== request.batteryVersion || result.battery !== request.battery
    || result.requestId !== request.requestId || (result.status !== 'settled' && result.status !== 'held')) return undefined;
  const settled = result.status === 'settled';
  if (!keys(result, ['protocolVersion', 'batteryVersion', 'requestId', 'battery', 'status', settled ? 'value' : 'reason', 'readings', 'outcome', 'evidence'])) return undefined;
  const readings = object(result.readings);
  const reading = object(readings?.language);
  const distribution = object(reading?.probabilities);
  if (!readings || !keys(readings, ['language']) || !reading || !keys(reading, ['kind', 'choice', 'confidence', 'probabilities', 'outcome'])
    || reading.kind !== 'choice' || !probability(reading.confidence) || typeof reading.choice !== 'string' || !(WEBUI_CODE_LANGUAGES as readonly string[]).includes(reading.choice)
    || !distribution || !keys(distribution, WEBUI_CODE_LANGUAGES)
    || typeof reading.outcome !== 'string' || !['act', 'confirm', 'escalate'].includes(reading.outcome) || result.outcome !== reading.outcome) return undefined;
  const probabilities: Record<string, number> = {};
  for (const [option, value] of Object.entries(distribution)) {
    if (!probability(value)) return undefined;
    probabilities[option] = value;
  }
  try { captureChoiceAnswer({ type: 'choice', choice: reading.choice, confidence: reading.confidence, probabilities }); }
  catch { return undefined; }
  if (!Array.isArray(result.evidence) || result.evidence.length !== 1) return undefined;
  const evidence = object(result.evidence[0]); const usage = object(evidence?.usage);
  if (!evidence || !keys(evidence, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs']) || !nonempty(evidence.decisionId)
    || !nonempty(evidence.model) || !nonempty(evidence.requestedModel) || !nonnegative(evidence.latencyMs)
    || !usage || !keys(usage, ['inputTokens', 'outputTokens']) || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens)) return undefined;
  if (!settled) return result.reason === 'uncertain' && reading.outcome !== 'act' ? { status: 'held' } : undefined;
  const value = object(result.value);
  if (!value || !keys(value, ['language']) || reading.outcome !== 'act' || value.language !== reading.choice) return undefined;
  return { status: 'ready', language: reading.choice as WebuiCodeLanguage };
}

/** Only owner-issued source revisions and structural offsets leave the browser. */
export async function readCodeLanguage(source: CodeSource, signal: AbortSignal): Promise<CodeLanguageResult> {
  const { sessionId, messageId, contentRevision, content, start, end } = source;
  if (!sessionId || !messageId || !contentRevision || sessionId.length > 256 || messageId.length > 256 || contentRevision.length > 256 || !source.content || source.content.length > 1_000_000 || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length || signal.aborted) return { status: 'held' };
  const lifetime = getClientLifetime(); const abort = new AbortController();
  const cancel = () => abort.abort(); const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const isCurrent = () => !signal.aborted && !abort.signal.aborted && isClientLifetimeCurrent(lifetime)
    && source.sessionId === sessionId && source.messageId === messageId && source.contentRevision === contentRevision
    && source.content === content && source.start === start && source.end === end;
  try {
    if (!isCurrent()) return { status: 'unavailable' };
    const request: Request = { protocolVersion: 1, requestId: randomUuid(), battery: 'webui.code.language', batteryVersion: 2,
      input: { sessionId, messageId, contentRevision, start, end } };
    const raw = await runBrowserJudgment(request, abort.signal);
    if (!isCurrent()) return { status: 'unavailable' };
    const result = readCodeLanguageResponse(request, raw);
    return result?.status === 'ready' ? { ...result, isCurrent } : result ?? { status: 'unavailable' };
  } catch (error) {
    if (error instanceof DecisionModelsDisabledError && isCurrent()) return { status: 'ready', language: 'plaintext', provenance: 'classic', isCurrent };
    return { status: 'unavailable' };
  }
  finally { unsubscribe(); signal.removeEventListener('abort', cancel); }
}

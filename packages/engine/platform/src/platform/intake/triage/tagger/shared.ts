/** Fixed provider meanings. No message-derived heuristics or arbitrary flags. */
export const TAGS = Object.freeze({
  'GoodVibes/Spam': Object.freeze({ imap: 'GoodVibes_Spam', slack: 'no_entry_sign', discord: '🚫' }),
  'GoodVibes/Priority': Object.freeze({ imap: 'GoodVibes_Priority', slack: 'rotating_light', discord: '🚨' }),
  'GoodVibes/Normal': Object.freeze({ imap: 'GoodVibes_Normal', slack: 'inbox_tray', discord: '📥' }),
});
export type TriageProviderTag = keyof typeof TAGS;

/**
 * What one label write did at the provider, per mark. `add` puts the label's
 * mark on the message; `remove` takes off the mark of another built-in label,
 * because Spam, Priority and Normal exclude each other.
 *   applied  - the provider made the change
 *   already  - it was already so (the mark was there, or for `remove` was not)
 *   skipped  - not tried: nothing maps this label to a mark on this message, or
 *              an earlier write for this message failed; `reason` says which
 *   failed   - the provider refused or could not be reached; `reason` says which
 * Other built-in marks are taken off only after every added mark is on, so a
 * failed write never leaves a message with no label it had.
 */
export interface TriageEffectResult {
  readonly tag: string;
  readonly action: 'add' | 'remove';
  readonly outcome: 'applied' | 'already' | 'skipped' | 'failed';
  readonly reason?: string;
}
export interface TriageTagWrite { readonly effects: readonly TriageEffectResult[] }

/**
 * The built-in labels whose marks a write of `meanings` takes off: every other
 * built-in label, once at least one written label is built-in.
 */
export function supersededLabels(meanings: Iterable<TriageProviderTag>): readonly TriageProviderTag[] {
  const kept = new Set(meanings);
  if (kept.size === 0) return [];
  return (Object.keys(TAGS) as TriageProviderTag[]).filter(tag => !kept.has(tag));
}

export interface TaggerGuard { readonly signal: AbortSignal; assertCurrent(): void }
export function current(guard: TaggerGuard): void { guard.signal.throwIfAborted(); if (guard.assertCurrent() !== undefined) throw new Error('Invalid triage lifetime proof'); }
export type TaggerHttp = typeof fetch;
/** Redirects cannot move credentials/effects. Guard every actual request and body await. */
export async function request(fetcher: TaggerHttp, url: string, init: RequestInit, guard: TaggerGuard): Promise<Response> {
  current(guard);
  const response = await fetcher(url, { ...init, redirect: 'error', signal: guard.signal });
  current(guard); return response;
}

/** A provider answer that was not a success, as a sentence: who, the status, and when to try again if it said. */
export function refusedBy(provider: string, response: Response): string {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    return `${provider} is rate limiting label writes${Number.isFinite(seconds) && seconds >= 0 ? `; try again in ${Math.ceil(seconds)} s` : '; try again later'}`;
  }
  if (response.status === 401 || response.status === 403) return `${provider} refused this account's access to the message (HTTP ${response.status}); check the account's token and permissions`;
  if (response.status === 404) return `${provider} no longer has this message (HTTP 404)`;
  return `${provider} did not accept the label write (HTTP ${response.status})`;
}

export async function json(response: Response, guard: TaggerGuard, provider = 'The provider'): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(refusedBy(provider, response));
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${provider} sent an empty answer`);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      current(guard); const part = await reader.read(); current(guard);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65536) { void reader.cancel().catch(() => {}); throw new Error(`${provider} sent an answer larger than 64 KB`); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${provider} sent an answer that is not JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${provider} sent an answer that is not a JSON object`);
  return value as Record<string, unknown>;
}

/**
 * Send one provider write. A cancelled or revoked write throws (the caller
 * reports it as stopped); a network failure is the effect's failure.
 */
export async function attempt(provider: string, guard: TaggerGuard, send: () => Promise<Response>): Promise<Response | string> {
  try { return await send(); } catch (error) {
    if (guard.signal.aborted) throw error;
    current(guard);
    return `${provider} could not be reached; the label write can be tried again`;
  }
}

/** Effects not tried because an earlier write for the message failed. */
export function notTried(effects: readonly { readonly tag: string; readonly action: 'add' | 'remove' }[]): TriageEffectResult[] {
  return effects.map(effect => ({ tag: effect.tag, action: effect.action, outcome: 'skipped' as const,
    reason: effect.action === 'add' ? 'Not tried: an earlier label write for this message failed' : 'Kept: the new label was not fully written' }));
}

/** A provider's error text, only when it is a short code (Slack's `error`), never free text. */
export function providerCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : undefined;
}

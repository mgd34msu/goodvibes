import { getBuiltinSubscriptionProvider } from './subscription-providers.js';
import { SubscriptionSessionEndedError, type SubscriptionManager } from './subscriptions.js';

/**
 * The access token to send for a built-in subscription provider, renewed first
 * when it is at or near its expiry. Null when no sign-in is stored or the
 * provider refused it; a renewal that could not be judged throws.
 */
export async function resolveSubscriptionAccessToken(
  provider: string,
  manager: Pick<SubscriptionManager, 'resolveAccessToken'>,
): Promise<string | null> {
  const builtin = getBuiltinSubscriptionProvider(provider);
  if (!builtin) return null;
  try {
    return await manager.resolveAccessToken(provider, builtin.oauth);
  } catch (error) {
    if (error instanceof SubscriptionSessionEndedError) return null;
    throw error;
  }
}

/**
 * What one recovery attempt concluded. `refreshed` carries the token to retry
 * with (possibly minted by a concurrent caller or another process rather than
 * this one). `session-dead` means the authorization server refused the grant:
 * the session is over and only a new sign-in helps. `unavailable` means the
 * refresh could not be judged (transport failure, a 5xx from the token
 * endpoint, a malformed answer): the session's true state is unknown and the
 * caller must NOT tell the user to sign in again.
 */
export type SubscriptionRefreshOutcome =
  | { readonly kind: 'refreshed'; readonly accessToken: string }
  | { readonly kind: 'session-dead' }
  | { readonly kind: 'unavailable'; readonly error: unknown };

function openaiOAuth() {
  return getBuiltinSubscriptionProvider('openai')?.oauth ?? null;
}

/**
 * One recovery for the stored OpenAI subscription after the backend refused
 * `rejectedAccessToken`. The renewal is the store's own
 * ({@link SubscriptionManager.resolveAccessToken}): one locked claim and one
 * request across every caller and process, so the rotating refresh token is
 * spent once, and a store that already holds a different token answers
 * without spending anything.
 *
 * The exchange is time-bounded (oauth-core) but deliberately not wired to any
 * one turn's abort signal: the attempt is shared by every concurrent caller,
 * and one caller cancelling its turn must not abort the recovery the others
 * are awaiting.
 */
export async function refreshOpenAISubscriptionAfterRejection(
  manager: Pick<SubscriptionManager, 'resolveAccessToken'>,
  rejectedAccessToken: string,
): Promise<SubscriptionRefreshOutcome> {
  const oauth = openaiOAuth();
  if (!oauth) return { kind: 'session-dead' };
  try {
    const accessToken = await manager.resolveAccessToken('openai', oauth, { rejectedAccessToken });
    return accessToken === null ? { kind: 'session-dead' } : { kind: 'refreshed', accessToken };
  } catch (error) {
    if (error instanceof SubscriptionSessionEndedError) return { kind: 'session-dead' };
    return { kind: 'unavailable', error };
  }
}

/**
 * Interaction-free freshness maintenance, called before a send: a token at or
 * near its expiry is renewed silently, so the ordinary expiry case never even
 * produces a rejected request. A renewal that could not be judged falls back
 * to the stored token; the send may still work, and the rejection path
 * backstops it if not.
 */
export async function resolveFreshOpenAIAccessToken(
  manager: Pick<SubscriptionManager, 'get' | 'resolveAccessToken'>,
): Promise<SubscriptionRefreshOutcome | { kind: 'unconfigured' }> {
  const existing = manager.get('openai');
  if (!existing) return { kind: 'unconfigured' };
  if (existing.revokedAt !== undefined) return { kind: 'session-dead' };
  const oauth = openaiOAuth();
  if (!oauth) return { kind: 'refreshed', accessToken: existing.accessToken.reveal('dispatch') };
  try {
    const accessToken = await manager.resolveAccessToken('openai', oauth);
    return accessToken === null ? { kind: 'unconfigured' } : { kind: 'refreshed', accessToken };
  } catch (error) {
    if (error instanceof SubscriptionSessionEndedError) return { kind: 'session-dead' };
    return { kind: 'refreshed', accessToken: existing.accessToken.reveal('dispatch') };
  }
}

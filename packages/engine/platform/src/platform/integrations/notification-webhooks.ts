/**
 * notification-webhooks.ts, the one owner of how a notification webhook URL is
 * kept, read back and shown.
 *
 * An incoming webhook's URL carries its key or topic: holding it is posting
 * rights. `notifications.webhookUrls` is declared secret-bearing
 * (secret-bearing-config-keys.ts), so each member of the list is a
 * `goodvibes://secrets/` reference and the URL itself lives in the secret
 * store under its own key. `/notify add` stores it ({@link storeNotificationWebhook}),
 * the notifier resolves a member only at dispatch
 * ({@link resolveNotificationWebhook}), and every screen shows its scheme and
 * host only ({@link shownNotificationWebhook}).
 *
 * Cost: one secret-store write per URL added; one local secret read per URL
 * per notification sent (an in-process read of the store, no request).
 */
import { randomBytes } from 'node:crypto';
import { buildGoodVibesSecretRef } from '../config/secret-backed-config.js';
import { isSecretReferenceValue } from '../config/secret-bearing-config-keys.js';
import { resolveSecretInput } from '../config/secret-ref-refusal.js';
import { normalizeSecretRef } from '../config/secret-refs.js';
import type { SecretsManager } from '../config/secrets.js';

/** The secret-store key family the notification webhook URLs are kept under. */
export const NOTIFICATION_WEBHOOK_SECRET_PREFIX = 'GOODVIBES_NOTIFY_WEBHOOK_';

/** The store a URL is written to and read back from. */
export type NotificationWebhookSecretStore = Pick<SecretsManager, 'get' | 'set' | 'delete' | 'getGlobalHome' | 'getSecretProviderHostConfig'>;

/**
 * Store `url` under a new key of its own and return the reference the
 * settings list keeps in its place. The daemon tier, because the daemon sends
 * its own notices (memory pressure) to the same list and every client reads
 * that tier.
 */
export async function storeNotificationWebhook(url: string, secrets: Pick<SecretsManager, 'set'>): Promise<string> {
  const key = `${NOTIFICATION_WEBHOOK_SECRET_PREFIX}${randomBytes(6).toString('hex').toUpperCase()}`;
  await secrets.set(key, url, { scope: 'daemon' });
  return buildGoodVibesSecretRef(key);
}

/** Remove the stored URL a list member names; a member that is not a reference of this family stores nothing. */
export async function forgetNotificationWebhook(entry: string, secrets: Pick<SecretsManager, 'delete'>): Promise<void> {
  const key = notificationWebhookSecretKey(entry);
  if (key !== null) await secrets.delete(key, { scope: 'daemon' });
}

/** The secret-store key a list member names, when it is a reference to one of these URLs. */
export function notificationWebhookSecretKey(entry: string): string | null {
  if (!isSecretReferenceValue(entry)) return null;
  const ref = normalizeSecretRef(entry.trim());
  return ref?.source === 'goodvibes' && ref.id.startsWith(NOTIFICATION_WEBHOOK_SECRET_PREFIX) ? ref.id : null;
}

/**
 * The URL a list member stands for: the stored URL for a reference (resolved
 * through the secret store, or the provider the reference names), the member
 * itself for a literal URL handed to the notifier directly. Null when the
 * reference cannot be read.
 */
export async function resolveNotificationWebhook(entry: string, secrets: Pick<SecretsManager, 'get' | 'getGlobalHome' | 'getSecretProviderHostConfig'>): Promise<string | null> {
  if (!isSecretReferenceValue(entry)) return entry;
  return resolveSecretInput(entry.trim(), {
    diagnosticMode: 'structural',
    resolveLocalSecret: (key) => secrets.get(key),
    homeDirectory: secrets.getGlobalHome(),
    providers: secrets.getSecretProviderHostConfig(),
  }, 'dispatch');
}

/**
 * The same, read synchronously from this machine's own store, for a listing
 * that only shows a host. Null when the member is a reference this machine
 * cannot read without a request.
 */
export function resolveNotificationWebhookLocally(entry: string, secrets: Pick<SecretsManager, 'resolveLocalSecretSync'> | undefined): string | null {
  if (!isSecretReferenceValue(entry)) return entry;
  const ref = normalizeSecretRef(entry.trim());
  if (!secrets || ref?.source !== 'goodvibes') return null;
  const stored = secrets.resolveLocalSecretSync(ref.id);
  return stored.state === 'resolved' ? stored.value.reveal('dispatch') : null;
}

/** What a screen shows of a notification webhook URL: its scheme and host, never the path or query that carry its key. */
export function shownNotificationWebhook(url: string | null): string {
  if (url === null) return '(stored URL not readable here)';
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' && !parsed.search ? parsed.origin : `${parsed.origin}/…`;
  } catch {
    return '(invalid URL)';
  }
}

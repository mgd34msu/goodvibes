/**
 * secret-bearing-config-keys.ts, the config keys whose VALUE is a credential.
 *
 * Distinct from `credential-scope-registry.ts`, and the two answer different
 * questions. That one asks "does the daemon need this SECRET", and routes it to
 * the right store. This one asks "does this CONFIG KEY hold credential material
 * rather than a setting", and the answer decides three things a config key
 * cannot decide for itself:
 *
 *   - a write goes into the encrypted secret store, with only a
 *     `goodvibes://secrets/…` reference left in the config file;
 *   - a render masks it, at rest AND while it is being typed;
 *   - a diagnostic dump redacts it.
 *
 * ── Why it is here and not in each product ──────────────────────────────────
 *
 * It was in each product. goodvibes-tui and goodvibes-agent each carried a
 * hand-maintained `SECRET_CONFIG_KEYS`, the web UI carried a third list for
 * masking only, and the three had already drifted from each other and from the
 * schema. `surfaces.email.password` and `surfaces.calendar.caldavPassword` were
 * missing from the set that routes a write, so their own schema descriptions,
 * which read "Stored in the daemon secret tier, never in config", were
 * aspirational: the settings modal wrote both as plain strings into a config
 * JSON file, and the generic `/config set` had no detection at all.
 *
 * This is the one list: `isSecretConfigKey` and `SECRET_CONFIG_KEYS`
 * (secret-backed-config.ts), which route a settings write into the store, are
 * this list, and `configKeyFacts(key).secret` reads it for the settings
 * admission, which refuses a literal value for any key here. Card material is
 * declared beside it as `PAYMENTS_SYNTHETIC_CONFIG_KEYS` and is never a setting.
 *
 * ── Why it is a list rather than a name pattern ─────────────────────────────
 *
 * Because a name pattern is a habit, not a rule. Every redactor in this
 * platform matched by trailing word, `…password`, `…token`, `…secret`, and
 * every one of them was blind to a key that did not fit the habit:
 * `surfaces.msteams.appPassword` ends in `Password` and matched;
 * `cardNumber`, `cardExpiry` and `cardholderName` end in none of them and
 * matched nothing at all. A declared list is checkable, reviewable, and wrong
 * only in ways someone can see.
 */

/**
 * Every platform config key whose value is credential material.
 *
 * Grouped by the surface that owns the setting, so a channel added without its
 * credential is visible as a gap in the group rather than invisible in a sorted
 * list.
 */
export const SECRET_BEARING_CONFIG_PATHS: readonly string[] = [
  // The daemon's own mailbox and calendar account.
  'surfaces.email.password',
  'surfaces.email.imap.password',
  'surfaces.email.smtp.password',
  'surfaces.calendar.caldavPassword',

  // The calendar connector. These hold a REFERENCE by design, which is exactly
  // why they belong here: a reference field that has been handed a literal
  // password is the failure this set exists to catch and repair.
  'calendar.google.clientSecretRef',
  'calendar.microsoft.clientSecretRef',
  'calendar.google.icsUrl',
  'google.oauth.refreshToken',

  // Chat and notification surfaces, all run by the daemon.
  'surfaces.slack.botToken',
  'surfaces.slack.signingSecret',
  'surfaces.slack.appToken',
  'surfaces.discord.botToken',
  'surfaces.ntfy.token',
  // On a public ntfy server a topic name is all a stranger needs to post work
  // into it or read the replies: each topic is a credential, stored as a
  // reference and shown masked.
  'surfaces.ntfy.topic',
  'surfaces.ntfy.chatTopic',
  'surfaces.ntfy.agentTopic',
  'surfaces.ntfy.remoteTopic',
  'surfaces.telegram.botToken',
  'surfaces.telegram.webhookSecret',
  'surfaces.googleChat.verificationToken',
  // An incoming webhook URL carries its key and token: holding it is posting
  // rights. Found when the credential-scope gate began failing closed on
  // unsettled readings (config.credential-key v2).
  'surfaces.googleChat.webhookUrl',
  'surfaces.signal.token',
  'surfaces.whatsapp.accessToken',
  'surfaces.whatsapp.verifyToken',
  'surfaces.whatsapp.signingSecret',
  'surfaces.imessage.token',
  'surfaces.msteams.appPassword',
  'surfaces.msteams.webhookSecret',
  'surfaces.bluebubbles.password',
  'surfaces.mattermost.botToken',
  'surfaces.mattermost.webhookSecret',
  'surfaces.matrix.accessToken',
  'surfaces.matrix.webhookSecret',
  'surfaces.webhook.secret',
  // The default reply target is an outbound webhook URL, which commonly
  // carries its own token; its credential reading could not settle, so it is
  // declared (config.credential-key v2, fail-closed credential-scope gate).
  'surfaces.webhook.defaultTarget',
  // The notification webhooks: a list of the same kind of URL, held whole.
  'notifications.webhookUrls',
  'surfaces.homeassistant.accessToken',
  'surfaces.homeassistant.webhookSecret',

  // Telephony delivery.
  'surfaces.telephony.authToken',
  'surfaces.telephony.token',
  'surfaces.telephony.webhookSecret',

  // Cloudflare tokens, held as references like `calendar.google.clientSecretRef` and for the
  // same reason. Found by the credential-key readings (config.credential-key),
  // which the old trailing-word pattern missed: none ends in `token`.
  'cloudflare.apiTokenRef',
  'cloudflare.workerTokenRef',
  'cloudflare.workerClientTokenRef',
  'cloudflare.tunnelTokenRef',
  'cloudflare.accessServiceTokenRef',

  // Cluster key material.
  'cluster.groupMaterial',
  // The shared phrase nodes sign coordination messages with. Found by the
  // declaration-coverage check rather than by anyone noticing: it was declared
  // nowhere, the state the pre-commit credential-scope check now refuses.
  'cluster.secret',
];

const SECRET_BEARING_SET = new Set<string>(SECRET_BEARING_CONFIG_PATHS);

/**
 * True when this config key's value is credential material: exact membership
 * in the declared list. This list is what `configKeyFacts(key).secret`
 * (config-key-facts.ts) reports, so a writer, a masker and a settings screen
 * all read the same answer. A key the list does not name is not guessed at
 * from its spelling: a schema key it omits is not a credential, and a key the
 * schema does not know is kept out of view (`isProtectedConfigValue`). The
 * pre-commit credential-scope check compares the stored readings of every
 * schema key against this list.
 */
export function isSecretBearingConfigKey(key: string): boolean {
  return SECRET_BEARING_SET.has(key);
}

/** True when this key is DECLARED; the same test as {@link isSecretBearingConfigKey}. */
export function isDeclaredSecretBearingConfigKey(key: string): boolean {
  return SECRET_BEARING_SET.has(key);
}

/**
 * A stored config value that is a `goodvibes://` reference rather than a
 * literal. A reference is the correct at-rest shape; a literal is the defect.
 */
export function isSecretReferenceValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('goodvibes://secrets/');
}

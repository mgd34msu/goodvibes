/**
 * config-ownership.ts, which runtime OWNS a config key.
 *
 * Ownership follows the runtime that ACTS on a setting, not the client that
 * happens to edit it. Before this module existed, every product wrote every key
 * into its own surface silo (`~/.goodvibes/agent/settings.json`,
 * `~/.goodvibes/tui/settings.json`, ...). The daemon reads exactly one of those
 * files, so a Telegram bot username set from the agent reported success, landed
 * in the agent's file, and configured nothing: Telegram runs in the daemon.
 *
 * Three scopes:
 *
 * - `daemon`, the daemon executes it unattended, so it has exactly one home:
 *   the daemon tier (`~/.goodvibes/daemon/settings.json`). Chat surfaces,
 *   control-plane binding, watchers and triggers, device pairing and grants,
 *   local voice provisioning, delivery, at-rest retention.
 *
 * - `client`, presentation and per-installation lifecycle. Genuinely local and
 *   genuinely different between the TUI, the agent and the web UI: rendering,
 *   theme, transcript display, keybindings, and the "do I run/embed a daemon at
 *   all" switches (`daemon.*`, `service.*`) which are a property of THIS
 *   installation, not of the daemon's behavior.
 *
 * Each schema domain states its owner in CONFIG_DOMAIN_OWNERS below, which the
 * type checker holds complete; a key outside every schema domain is `client`.
 *
 * - `user`, cross-client defaults that ride the surface-root-independent
 *   shared tier (`~/.goodvibes/shared/settings.json`).
 *
 * Two user-level precedences exist and the difference is deliberate:
 *   - `shared-wins` (the voice/tts keys, unchanged since the shared tier
 *     shipped): the shared value overlays the surface value, so every surface
 *     speaks with one voice.
 *   - `local-override` (model / reasoning effort): the shared value is a
 *     DEFAULT that applies only where the surface has not set the key itself,
 *     which is what "a client may override locally" means.
 */

import type { ConfigKey } from './schema.js';
import type { ListConfigKey } from './schema-types-lists.js';
import { CONFIG_SCHEMA } from './schema.js';

/** Which runtime owns, and therefore writes, a config key. */
export type ConfigScope = 'daemon' | 'client' | 'user';

/** The first segment of a key: `surfaces` for `surfaces.telegram.enabled`. */
type DomainOf<K> = K extends `${infer D}.${string}` ? D : never;

/** Every settings domain the schema declares, the list-valued settings included. */
export type ConfigDomain = DomainOf<ConfigKey | ListConfigKey>;

/**
 * Which runtime acts on each settings domain: the one place a domain's owner
 * is declared. The type is a record over every domain the schema has, so a new
 * domain does not compile until it is answered here, and the answer is made
 * when the setting is added rather than discovered when it configures nothing.
 *
 * `daemon` means the daemon executes it unattended (chat surfaces, the control
 * plane, watchers, delivery, payments, the decision layer, web push, the
 * Cloudflare tunnel and worker), so its one home is the daemon tier and every
 * product on the machine reads that one value. `client` means presentation or
 * per-installation lifecycle that genuinely differs between the terminal app,
 * the agent and the web UI.
 *
 * Deliberately `client`, and why:
 *   - `daemon` : "does THIS installation run or embed a daemon"; the agent
 *                answers no and the terminal app yes, and neither answer is
 *                the daemon's to give (`daemon.timezone` is the exception below).
 *   - `service`: per-installation platform-service lifecycle, same shape.
 *   - `voice`  : the wake word listens inside each client process; only the
 *                local speech engines (`voice.local.`) are the daemon's.
 */
export const CONFIG_DOMAIN_OWNERS: Readonly<Record<ConfigDomain, 'daemon' | 'client'>> = {
  // Chat surfaces, the control plane and how it is reached.
  surfaces: 'daemon',
  controlPlane: 'daemon',
  httpListener: 'daemon',
  web: 'daemon',
  relay: 'daemon',
  // Scheduled and triggered work, devices, delivery, retention.
  watchers: 'daemon',
  device: 'daemon',
  automation: 'daemon',
  checkin: 'daemon',
  integrations: 'daemon',
  atRest: 'daemon',
  // The daemon holds the card and charges it with every surface closed (docs/payments.md).
  payments: 'daemon',
  // The daemon receives inbound channel messages and decides whether one becomes work.
  conversationGate: 'daemon',
  // Hosted sessions run in the daemon, which enforces their cap and detach policy.
  hostedSessions: 'daemon',
  // Leader election decides which node consumes inbound channel messages.
  cluster: 'daemon',
  // The owner profile has the daemon as its single writer.
  profile: 'daemon',
  // The occasions sweep runs in the daemon on a timer.
  occasions: 'daemon',
  // The calendar connector the daemon reads through unattended (the mailbox is
  // `surfaces.email.*`, daemon-owned with the rest of `surfaces`).
  calendar: 'daemon',
  google: 'daemon',
  // The daemon asks the decision layer for every engine judgment, and the
  // terminal apps read the same value back, so one setting configures them all.
  judgment: 'daemon',
  // The daemon signs web-push notifications and sweeps the subscriptions.
  push: 'daemon',
  // The daemon provisions and runs its own tunnel and edge worker.
  cloudflare: 'daemon',
  // Worktree setup is run by whichever process provisions the worktree (the
  // daemon's worktrees.setup.run, the orchestration engine): one value on the
  // daemon tier, so the setting the operator sees is the one setup reads.
  worktree: 'daemon',

  agents: 'client',
  batch: 'client',
  behavior: 'client',
  cache: 'client',
  checkpoints: 'client',
  contract: 'client',
  daemon: 'client',
  danger: 'client',
  diagnostics: 'client',
  display: 'client',
  fetch: 'client',
  fleet: 'client',
  helper: 'client',
  learning: 'client',
  memory: 'client',
  network: 'client',
  notifications: 'client',
  orchestration: 'client',
  permissions: 'client',
  planner: 'client',
  policy: 'client',
  power: 'client',
  pricing: 'client',
  provider: 'client',
  runtime: 'client',
  sandbox: 'client',
  security: 'client',
  service: 'client',
  storage: 'client',
  telemetry: 'client',
  tools: 'client',
  tts: 'client',
  ui: 'client',
  update: 'client',
  voice: 'client',
};

/** Subtrees the daemon owns inside a client domain: local voice provisioning is model files on the daemon's disk. */
// `storage.secretProviders.`: how this machine runs its password managers, one
// value every product and the daemon resolve secret references with.
const DAEMON_OWNED_SUBTREES: readonly string[] = ['voice.local.', 'storage.secretProviders.'];

/**
 * The daemon-owned prefixes, derived from {@link CONFIG_DOMAIN_OWNERS}: every
 * daemon domain plus the daemon subtrees. Read by the web UI's generated
 * ownership table; never edited by hand.
 */
export const DAEMON_OWNED_CONFIG_PREFIXES: readonly string[] = [
  ...Object.entries(CONFIG_DOMAIN_OWNERS).filter(([, owner]) => owner === 'daemon').map(([domain]) => `${domain}.`),
  ...DAEMON_OWNED_SUBTREES,
];

/** Individual daemon-owned keys that do not sit under a daemon-owned domain. */
export const DAEMON_OWNED_CONFIG_KEYS: readonly string[] = [
  'danger.httpListener',
  // The one `daemon.*` key that is NOT a per-installation switch.
  //
  // The rest of that prefix answers "does THIS machine run or embed a daemon",
  // which is rightly client-owned. `daemon.timezone` answers something else
  // entirely: where the daemon thinks it IS. Anything that resets on a calendar
  // day reads it, starting with the payment capability's daily budgets.
  //
  // Left client-owned it would land in whichever surface the operator happened
  // to set it from, and the daemon, the process that actually rolls the budget
  // over at midnight, would never see it and would keep resetting in UTC. The
  // operator would have picked a zone, been shown that zone, and had their
  // money reset in a different one.
  'daemon.timezone',
  // The hosts on the owner's own network that deliveries may reach: watchers and
  // channel webhooks run in the daemon, notification webhooks in every app, and
  // all of them read the one list the owner set, wherever he set it from.
  'network.privateDeliveryHosts',
];

/**
 * Daemon-owned config paths that are not rows of the settings table.
 *
 * `listDaemonOwnedConfigKeys()` is derived from CONFIG_SCHEMA, so a daemon
 * path with no row there would be invisible to everything that WALKS the owned
 * set (the migration, the daemon-tier overlay, a whole-config save's strip)
 * although `isDaemonOwnedConfigKey` routes its writes to the daemon store. The
 * paths here are those: credential references and key material that are never
 * shown as settings. Adding a path grows the covered set, which makes the
 * migration re-run on the next start and pick a stranded value up.
 */
export const DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS = [
  // The list settings (`conversationGate.gatedSurfaces`, `cluster.peers`, ...)
  // are rows of the settings table now (schema-domain-lists.ts) and reach the
  // owned set through it; only paths that are not settings stay here.
  //
  // The group's key material. Daemon-owned for the same reason the rest of the
  // cluster's settings are: the daemon is the only thing that reads it, and a
  // client silo can only hold a stale copy of it.
  //
  // Being daemon-owned does NOT make it replicate, `cluster.` is ruled
  // node-local in config-replication-policy.ts, and for this key that ruling is
  // load-bearing rather than incidental. See the note there.
  'cluster.groupMaterial',
  // The Google OAuth refresh token is a secret, never a setting: no settings
  // row shows it and no file holds it. The path stays here because the
  // daemon-owned secret name derives from it, and because `google.oauth.` is
  // ruled replicated, which is what carries the token to a node that takes
  // over a handover.
  'google.oauth.refreshToken',
  // Mailbox password references under `email.*` name a daemon-owned secret.
  'email.passwordRef',
  'email.smtpPasswordRef',
  // The calendar connector's `calendar.*` and `google.*` keys are real
  // CONFIG_SCHEMA entries (schema-domain-connectors.ts), daemon-owned by their
  // prefix, so they are not repeated here: this list is for paths that are NOT
  // scalar schema keys, and a repeat would double-count them in every
  // owned-set walk.
] as const;

/** A daemon-owned path that has no scalar CONFIG_SCHEMA entry. */
export type DaemonOwnedNonSchemaConfigPath = (typeof DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS)[number];

/** Any path the daemon owns: a schema key, or a non-scalar path listed above. */
export type DaemonOwnedConfigPath = ConfigKey | DaemonOwnedNonSchemaConfigPath;

/**
 * User-level keys whose shared value OVERLAYS the surface value. This is the
 * original shared tier (see shared-config-tier.ts) and its behavior is
 * unchanged: one voice on every surface.
 */
export const USER_SHARED_WINS_CONFIG_KEYS: readonly string[] = [
  'provider.decisionRouter', // one category table across all user surfaces, selected only by the virtual provider
  'tts.provider',
  'tts.voice',
  'tts.speed',
  'tts.llmProvider',
  'tts.llmModel',
];

/**
 * User-level keys whose shared value is only a DEFAULT: a surface that carries
 * its own explicit value keeps it. Set through `ConfigManager.setUserDefault`;
 * an ordinary `set` on one of these writes the surface-local override, which is
 * the behavior every existing installation already has.
 */
export const USER_LOCAL_OVERRIDE_CONFIG_KEYS: readonly string[] = [
  'provider.model',
  'provider.reasoningEffort',
];

const DAEMON_KEY_SET = new Set<string>(DAEMON_OWNED_CONFIG_KEYS);
const DAEMON_NON_SCHEMA_PATH_SET = new Set<string>(DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS);
const USER_SHARED_WINS_SET = new Set<string>(USER_SHARED_WINS_CONFIG_KEYS);
const USER_LOCAL_OVERRIDE_SET = new Set<string>(USER_LOCAL_OVERRIDE_CONFIG_KEYS);

/**
 * True when the daemon is the single writer and reader-of-record for `key`.
 *
 * The non-schema list is consulted HERE and not only by the owned-set walk.
 * When that list held nothing but `conversationGate.gatedSurfaces` and
 * `cluster.peers` the distinction did not matter: both sit under a daemon-owned
 * PREFIX, so this predicate already answered yes and the list existed purely so
 * a walk over owned paths would not miss a non-scalar. `email.passwordRef`, the
 * calendar client secrets and the Google refresh token went through exactly
 * that gap for a while: they were on this list before `email.`/`calendar.`/
 * `google.` were daemon-owned prefixes, so the two answers disagreed, the
 * walk called them daemon-owned while this predicate called them client-owned.
 * They are schema keys under those prefixes now (schema-domain-connectors.ts),
 * so the prefix match alone answers yes for all of them.
 *
 * A key nobody claims is not stored twice, it is stored NOWHERE. The manager
 * routes daemon-owned keys to the daemon tier and everything else to the
 * surface tier, and a dynamic key that failed both tests was accepted, reported
 * as saved, and written to neither file. That is the exact silence config
 * ownership exists to prevent, applied to a password reference.
 */
export function isDaemonOwnedConfigKey(key: string): boolean {
  if (DAEMON_KEY_SET.has(key)) return true;
  if (DAEMON_NON_SCHEMA_PATH_SET.has(key)) return true;
  if (DAEMON_OWNED_SUBTREES.some((prefix) => key.startsWith(prefix))) return true;
  const dot = key.indexOf('.');
  const domain = dot > 0 ? key.slice(0, dot) : '';
  return Object.hasOwn(CONFIG_DOMAIN_OWNERS, domain) && CONFIG_DOMAIN_OWNERS[domain as ConfigDomain] === 'daemon';
}

/** True when `key` rides the cross-client user tier (either precedence). */
export function isUserLevelConfigKey(key: string): boolean {
  return USER_SHARED_WINS_SET.has(key) || USER_LOCAL_OVERRIDE_SET.has(key);
}

/** True when a user-level key's shared value overlays the surface value. */
export function userTierOverlaysSurface(key: string): boolean {
  return USER_SHARED_WINS_SET.has(key);
}

/** True when `key` is presentation/per-installation state owned by each client. */
export function isClientOwnedConfigKey(key: string): boolean {
  return configKeyScope(key) === 'client';
}

/**
 * The owning runtime for `key`. `client` is the default, so an unclassified or
 * brand-new key keeps writing to the surface silo it already writes to.
 */
export function configKeyScope(key: string): ConfigScope {
  if (isDaemonOwnedConfigKey(key)) return 'daemon';
  if (isUserLevelConfigKey(key)) return 'user';
  return 'client';
}

let daemonOwnedKeyCache: readonly ConfigKey[] | null = null;

/**
 * Every schema key the daemon owns, in schema order. Memoized: the load and
 * migration paths walk this list per settings file, and CONFIG_SCHEMA is a
 * frozen module constant.
 */
export function listDaemonOwnedConfigKeys(): readonly ConfigKey[] {
  daemonOwnedKeyCache ??= CONFIG_SCHEMA
    .map((setting) => setting.key)
    .filter((key) => isDaemonOwnedConfigKey(key));
  return daemonOwnedKeyCache;
}

let daemonOwnedPathCache: readonly DaemonOwnedConfigPath[] | null = null;

/**
 * Every path the daemon owns, schema keys PLUS the non-scalar paths above.
 *
 * This is the list every owned-set walk should use: migration, the daemon-tier
 * overlay, whole-config strip, and reset. `listDaemonOwnedConfigKeys` remains
 * for callers that genuinely need schema keys only (typed `get`/`set` surfaces).
 */
export function listDaemonOwnedConfigPaths(): readonly DaemonOwnedConfigPath[] {
  daemonOwnedPathCache ??= [
    ...listDaemonOwnedConfigKeys(),
    ...DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
  ];
  return daemonOwnedPathCache;
}

/**
 * Human-readable reason a client may not be the writer for `key`, used by the
 * routing layer's failure text so "this went somewhere else" is never silent.
 */
export function describeConfigOwnership(key: string): string {
  switch (configKeyScope(key)) {
    case 'daemon':
      return `${key} is daemon-owned: the daemon executes it, so the daemon's config is its only home.`;
    case 'user':
      return `${key} is a user-level default shared across clients.`;
    default:
      return `${key} is client-owned and stays in this client's own settings.`;
  }
}

/**
 * surface-credential.ts, the credential an inbound adapter checks a caller against.
 *
 * ── What this exists to fix ─────────────────────────────────────────────────
 *
 * `sweepPlaintextCredentials` (config/plaintext-credential-sweep.ts) moves a
 * literal surface credential out of the config file into the encrypted store
 * and leaves a `goodvibes://secrets/goodvibes/<KEY>` reference in its place.
 * That is the correct at-rest shape and every DELIVERY path already resolves
 * it. The inbound adapters did not: each read its config value raw and compared
 * it byte-for-byte against what the caller presented, so once a surface had
 * been swept it answered 401 to every inbound POST.
 *
 * Telegram webhook mode was the worst of it, because the two halves disagreed
 * within one surface: the daemon registers the webhook with the RESOLVED secret
 * (channels/telegram/ingress.ts), so Telegram sends the real value and the
 * adapter rejected it against the unresolved reference text. Polling mode never
 * reads the config value, which is why this could sit unnoticed.
 *
 * ── Why one helper and not fifteen call sites ───────────────────────────────
 *
 * Fifteen read sites across twelve adapters had the same three-line shape, and
 * fifteen copies of a rule is how the thirteenth adapter gets it wrong. More
 * pointedly, the correct fix is NOT "wrap the read in `resolveSecretInput`",
 * doing exactly that at each site introduces an authentication bypass (below).
 * A shared function is the only place that rule can be stated once and be true
 * for every adapter, including ones not written yet.
 *
 * ── The bypass this type exists to prevent ──────────────────────────────────
 *
 * `resolveSecretInput` returns `string | null`, and null means three different
 * things: nothing was configured, a reference failed to resolve, or a
 * reference-shaped value was refused. Inbound routes require a configured
 * credential; absence reports an unconfigured webhook, while a broken reference
 * reports unavailable credentials. Neither case authorizes an inbound caller.
 *
 * So the three outcomes stay distinguishable in the type, and an adapter cannot
 * accidentally treat the third as the first: `absent` is a surface with no
 * credential, `unresolvable` is a surface whose credential is broken, and only
 * `resolved` carries a value to compare.
 */

import { logger } from '../utils/logger.js';
import { readSecretProviderHostConfig, resolveSecretInput, type SecretRefResolutionOptions } from '../config/secret-refs.js';
import type { SecretsManager } from '../config/secrets.js';
import { channelCredentials } from '../channels/credential-holder.js';

/**
 * The credential an adapter should check against, or the reason it has none.
 *
 * Deliberately not `string | null`. See the bypass note above: an adapter that
 * cannot tell "nothing configured" from "configured but broken" will read the
 * second as the first and stop authenticating.
 */
export type SurfaceCredential =
  /** A usable credential. This is the only shape carrying a value. */
  | { readonly state: 'resolved'; readonly value: string }
  /**
   * No credential is configured anywhere. The surface is unconfigured.
   * `setting` names where to set one: the first config key among the
   * sources, else the first environment variable.
   */
  | { readonly state: 'absent'; readonly setting: string }
  /**
   * A credential IS configured and could not be produced, a reference whose
   * secret is missing from the store, in a scope this process cannot read, or
   * malformed. Never authorise on this.
   */
  | { readonly state: 'unresolvable'; readonly configKey: string };

/** Where an adapter looks for its credential, in the order it looks. */
export type SurfaceCredentialSource =
  /** A config key. The only kind that can hold a `goodvibes://` reference. */
  | { readonly kind: 'config'; readonly key: string }
  /** A registered service secret. Already resolved by the registry. */
  | { readonly kind: 'registry'; readonly service: string; readonly field: ServiceSecretFieldName }
  /** An environment variable. Always a literal. */
  | { readonly kind: 'env'; readonly name: string };

/** The registry secret slots the adapters ask for. */
type ServiceSecretFieldName = 'primary' | 'password' | 'authToken' | 'signingSecret' | 'appToken' | 'publicKey';

/**
 * The slice of an adapter context this needs.
 *
 * Structural, so both `SurfaceAdapterContext` and
 * `GenericWebhookAdapterContext` satisfy it without either importing the other,
 * and so a test can supply three fields instead of thirty.
 */
export interface SurfaceCredentialContext {
  readonly configManager: { get(key: string): unknown };
  readonly serviceRegistry?: {
    resolveSecret(service: string, field: ServiceSecretFieldName): Promise<string | null>;
    /** The registry entry, when the registry can show it: a held credential is keyed by it. */
    get?(service: string): unknown;
  } | undefined;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
}

function secretRefOptions(context: SurfaceCredentialContext, configKey: string): SecretRefResolutionOptions {
  const secrets = context.secretsManager;
  return {
    resolveLocalSecret: secrets ? (key) => secrets.get(key) : undefined,
    homeDirectory: secrets?.getGlobalHome?.() ?? undefined,
    providers: readSecretProviderHostConfig(context.configManager),
    configKey,
  };
}

/** Where a person sets the credential these sources read: the first setting, else the first environment variable. */
function settingOf(sources: readonly SurfaceCredentialSource[]): string {
  const config = sources.find((source) => source.kind === 'config');
  if (config) return config.key;
  const env = sources.find((source) => source.kind === 'env');
  if (env) return env.name;
  const registry = sources.find((source) => source.kind === 'registry');
  return registry ? `the ${registry.service} service's ${registry.field}` : 'a credential';
}

/**
 * Read the first source that has a credential, resolving config references.
 *
 * ── Ordering, and why a broken config value does not fall through ───────────
 *
 * Sources are tried in the order given, which is the order each adapter already
 * used. A source that holds nothing is skipped. But a CONFIG source that holds
 * something and fails to resolve stops the walk and returns `unresolvable`
 * rather than continuing to the next source.
 *
 * That is deliberate. Falling through would mean an operator whose swept
 * reference broke gets quietly authenticated by a stale environment variable
 * instead, the surface keeps working, against a credential nobody chose, and
 * the broken reference is never noticed. A refusal that names the key in the
 * log is worse for one request and better for the operator, which is the same
 * trade `acceptRefShapedLiteral` already makes one layer down.
 *
 * Only config values are resolved. Registry values arrive already resolved, and
 * an environment variable is a literal by construction. Both config and
 * registry reads go through the process's credential holder
 * (channels/credential-holder.ts), the one delivery and status use, so a
 * password-manager reference is resolved once per process, not per request.
 */
export async function resolveSurfaceCredential(
  context: SurfaceCredentialContext,
  ...sources: readonly SurfaceCredentialSource[]
): Promise<SurfaceCredential> {
  for (const source of sources) {
    if (source.kind === 'config') {
      // Stringified before resolution, exactly as the raw reads did, so a
      // non-string literal in config behaves as it always has.
      //
      // Emptiness is tested on the UNTRIMMED string, so that a value which is
      // only whitespace counts as PRESENT and goes on to resolve (to nothing,
      // hence `unresolvable`). Trimming first would make "   " indistinguishable
      // from "not configured", and on the adapters that skip the comparison when
      // nothing is configured that reads a broken setting as an open door, the
      // same fail-open this whole module exists to prevent.
      const raw = String(context.configManager.get(source.key) ?? '');
      if (raw.length === 0) continue;
      const resolved = await channelCredentials.resolve(`config:${source.key}`, raw,
        () => resolveSecretInput(raw, secretRefOptions(context, source.key), 'dispatch'), context.secretsManager);
      if (resolved !== null && resolved.length > 0) return { state: 'resolved', value: resolved };
      return { state: 'unresolvable', configKey: source.key };
    }

    if (source.kind === 'registry') {
      const registry = context.serviceRegistry;
      if (!registry) continue;
      const value = (await channelCredentials.resolve(`service:${source.service}:${source.field}`, registry.get?.(source.service),
        () => registry.resolveSecret(source.service, source.field), context.secretsManager)) ?? '';
      if (value.length > 0) return { state: 'resolved', value };
      continue;
    }

    const value = process.env[source.name] ?? '';
    if (value.length > 0) return { state: 'resolved', value };
  }

  return { state: 'absent', setting: settingOf(sources) };
}

/**
 * Where each surface's inbound webhook finds the credential it checks callers
 * against, in the order it looks: the adapter and the channel doctor read the
 * same list, so the doctor's inbound check describes what the webhook does.
 * Surfaces whose inbound check is more than one credential (telephony,
 * Microsoft Teams) or that need none in some modes by design (Telegram's
 * managed webhook and polling, ntfy) keep their own reads.
 */
export const INBOUND_CREDENTIAL_SOURCES = {
  slack: [
    { kind: 'registry', service: 'slack', field: 'signingSecret' },
    { kind: 'config', key: 'surfaces.slack.signingSecret' },
    { kind: 'env', name: 'SLACK_SIGNING_SECRET' },
  ],
  discord: [
    { kind: 'registry', service: 'discord', field: 'publicKey' },
    { kind: 'config', key: 'surfaces.discord.publicKey' },
    { kind: 'env', name: 'DISCORD_PUBLIC_KEY' },
  ],
  whatsapp: [
    { kind: 'config', key: 'surfaces.whatsapp.signingSecret' },
    { kind: 'registry', service: 'whatsapp', field: 'signingSecret' },
    { kind: 'env', name: 'WHATSAPP_SIGNING_SECRET' },
    { kind: 'env', name: 'WHATSAPP_BRIDGE_TOKEN' },
  ],
  'google-chat': [
    { kind: 'config', key: 'surfaces.googleChat.verificationToken' },
    { kind: 'registry', service: 'google-chat', field: 'signingSecret' },
    { kind: 'env', name: 'GOOGLE_CHAT_VERIFICATION_TOKEN' },
  ],
  signal: [
    { kind: 'config', key: 'surfaces.signal.token' },
    { kind: 'registry', service: 'signal', field: 'primary' },
    { kind: 'env', name: 'SIGNAL_BRIDGE_TOKEN' },
  ],
  imessage: [
    { kind: 'config', key: 'surfaces.imessage.token' },
    { kind: 'registry', service: 'imessage', field: 'primary' },
    { kind: 'env', name: 'IMESSAGE_BRIDGE_TOKEN' },
  ],
  bluebubbles: [
    { kind: 'config', key: 'surfaces.bluebubbles.password' },
    { kind: 'registry', service: 'bluebubbles', field: 'password' },
    { kind: 'env', name: 'BLUEBUBBLES_PASSWORD' },
  ],
  // A secret of its own for inbound calls comes first, so the account's
  // delivery credential is not the shared secret a caller must hold. The
  // delivery credential stays as the fallback for a surface that has not set one.
  mattermost: [
    { kind: 'config', key: 'surfaces.mattermost.webhookSecret' },
    { kind: 'registry', service: 'mattermost', field: 'signingSecret' },
    { kind: 'env', name: 'MATTERMOST_WEBHOOK_SECRET' },
    { kind: 'config', key: 'surfaces.mattermost.botToken' },
    { kind: 'registry', service: 'mattermost', field: 'primary' },
    { kind: 'env', name: 'MATTERMOST_BOT_TOKEN' },
  ],
  matrix: [
    { kind: 'config', key: 'surfaces.matrix.webhookSecret' },
    { kind: 'registry', service: 'matrix', field: 'signingSecret' },
    { kind: 'env', name: 'MATRIX_WEBHOOK_SECRET' },
    { kind: 'config', key: 'surfaces.matrix.accessToken' },
    { kind: 'registry', service: 'matrix', field: 'primary' },
    { kind: 'env', name: 'MATRIX_ACCESS_TOKEN' },
  ],
} as const satisfies Record<string, readonly SurfaceCredentialSource[]>;

export type InboundCredentialSurface = keyof typeof INBOUND_CREDENTIAL_SOURCES;

/** The credential `surface`'s inbound webhook checks callers against. */
export function resolveInboundCredential(
  context: SurfaceCredentialContext,
  surface: InboundCredentialSurface,
): Promise<SurfaceCredential> {
  return resolveSurfaceCredential(context, ...INBOUND_CREDENTIAL_SOURCES[surface]);
}

/**
 * The response for a credential that is configured and cannot be produced.
 *
 * 503, not 401: nothing is wrong with the caller, and answering 401 sends
 * whoever debugs it hunting for a wrong token, which is precisely the wild
 * goose chase this whole defect caused.
 *
 * The body names no config key. The caller is a third party (Telegram, Twilio,
 * an operator's own script) and has no business learning which of this
 * daemon's settings is broken; the operator learns that from the log line,
 * which names the key and never the value.
 */
export function surfaceCredentialUnavailable(
  surface: string,
  credential: Extract<SurfaceCredential, { state: 'unresolvable' }>,
): Response {
  logger.error('Refusing inbound surface traffic: the configured credential could not be resolved', {
    surface,
    configKey: credential.configKey,
    action: 'the config value is a secret reference that resolved to nothing, re-save the credential for this surface',
  });
  return Response.json({
    error: 'Surface credential is configured but could not be resolved',
    reason: 'credential-unresolvable',
  }, { status: 503 });
}

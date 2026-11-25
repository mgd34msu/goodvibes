/**
 * Where a built-in surface's credential lives, read from one place: the setup
 * schema's secret targets.
 *
 * Each target names its service-registry slot, its config keys and its
 * environment variables. Setup stores a credential through `storeSurfaceSecret`,
 * which writes the secret AND the config reference the target names, so every
 * reader that resolves through `readSurfaceSecret` finds it. Setup for Discord
 * and ntfy used to store the token under a secret-store key no reader looked
 * at, answer success and switch the surface on; ten hand-written lookup chains
 * each restated (and in places skipped) where the token was.
 */
import { readSecretProviderHostConfig, resolveSecretInput } from '../../config/secret-refs.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema.js';
import type { SecretScope, SecretsManager } from '../../config/secrets.js';
import type { ServiceSecretField } from '../../config/service-registry.js';
import type { ChannelSecretSource, ChannelSecretTargetDescriptor, ChannelSurface } from '../types.js';
import { getBuiltinSetupSchema } from './setup-schema.js';
import { channelCredentials } from '../credential-holder.js';
import { unreadableSecretStore, type StoredSecretReader } from '../../config/secret-store-unreadable.js';

export interface SurfaceSecretReadDeps {
  readonly configManager: { get(key: string): unknown };
  /** Read only for a target that names a service slot; a reader of config-only targets (the ntfy topics) may leave it out. */
  readonly serviceRegistry?: {
    resolveSecret(serviceName: string, field: ServiceSecretField): Promise<string | null>;
    /** The registry entry, when the registry can show it: a held credential is keyed by it. */
    get?(serviceName: string): unknown;
  };
  readonly secretsManager?: (Pick<SecretsManager, 'get' | 'getGlobalHome'> & StoredSecretReader) | undefined;
}

export interface SurfaceSecretWriteDeps {
  readonly configManager: Pick<ConfigManager, 'set'>;
  readonly secretsManager: Pick<SecretsManager, 'set' | 'delete'>;
}

export interface SurfaceSecretReading {
  /** The credential, or null when nothing resolves. */
  readonly value: string | null;
  /** A value or reference is declared in some backend, whether or not it resolves. */
  readonly declared: boolean;
  readonly source: ChannelSecretSource;
  /**
   * The setting that holds the credential: the one whose reference did not
   * resolve when `source` is `unresolved`, otherwise the target's first
   * setting. Absent for a target with no setting (a webhook URL kept only in
   * the service registry or the environment).
   */
  readonly configKey?: string | undefined;
}

const SERVICE_FIELDS: ReadonlySet<string> = new Set<ServiceSecretField>([
  'primary', 'password', 'authToken', 'webhookUrl', 'signingSecret', 'publicKey', 'appToken',
]);

/** The setup schema's statement of one credential, or undefined when the surface declares none by that id. */
export function surfaceSecretTarget(surface: ChannelSurface, targetId: string): ChannelSecretTargetDescriptor | undefined {
  return getBuiltinSetupSchema(surface).secretTargets.find((target) => target.id === targetId);
}

function requireTarget(surface: ChannelSurface, targetId: string): ChannelSecretTargetDescriptor {
  const target = surfaceSecretTarget(surface, targetId);
  if (!target) throw new Error(`The ${surface} setup schema declares no secret target '${targetId}'`);
  return target;
}

function present(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/**
 * Read one credential: the service registry (and, for a target whose metadata
 * sets `serviceBaseUrl`, the service entry's base URL), then each config key
 * (a `goodvibes://secrets/...` reference is resolved), then each environment
 * variable. A config value that resolves to nothing is answered `unresolved`
 * at once and the environment is not read: a broken reference never switches
 * the surface to another account. That is also what lets status name the
 * setting that points at a missing secret.
 *
 * References are resolved through the process's credential holder
 * (channels/credential-holder.ts), the same one delivery asks, so status, the
 * doctor and every send share one resolution per reference.
 */
export async function readSurfaceSecret(
  deps: SurfaceSecretReadDeps,
  surface: ChannelSurface,
  targetId: string,
): Promise<SurfaceSecretReading> {
  const target = requireTarget(surface, targetId);
  const registry = deps.serviceRegistry;
  if (registry && target.serviceName && target.serviceField && SERVICE_FIELDS.has(target.serviceField)) {
    const serviceName = target.serviceName;
    const field = target.serviceField as ServiceSecretField;
    const registered = await channelCredentials.resolve(`service:${serviceName}:${field}`, registry.get?.(serviceName),
      () => registry.resolveSecret(serviceName, field), deps.secretsManager);
    if (registered) return { value: registered, declared: true, source: 'service-registry', ...configKeyOf(target) };
  }
  if (registry && target.serviceName && target.metadata.serviceBaseUrl === true) {
    const baseUrl = serviceBaseUrl(registry.get?.(target.serviceName));
    if (baseUrl) return { value: baseUrl, declared: true, source: 'service-registry', ...configKeyOf(target) };
  }
  for (const key of target.configKeys ?? []) {
    const raw = deps.configManager.get(key);
    if (!present(raw)) continue;
    const secrets = deps.secretsManager;
    const resolved = await channelCredentials.resolve(`config:${key}`, raw, () => resolveSecretInput(raw, {
      diagnosticMode: 'structural',
      ...(secrets ? { resolveLocalSecret: (name: string) => secrets.get(name) } : {}),
      homeDirectory: secrets?.getGlobalHome?.() ?? undefined,
      providers: readSecretProviderHostConfig(deps.configManager),
      configKey: key,
    }, 'dispatch'), secrets);
    if (resolved && resolved.trim()) return { value: resolved.trim(), declared: true, source: 'config', configKey: key };
    // A store this computer could not read: the credential is unknown, not missing.
    if (await storeUnreadable(deps, target)) return { value: null, declared: true, source: 'unreadable', configKey: key };
    return { value: null, declared: true, source: 'unresolved', configKey: key };
  }
  for (const name of target.envKeys ?? []) {
    const value = process.env[name];
    if (value && value.trim()) return { value: value.trim(), declared: true, source: 'env', ...configKeyOf(target) };
  }
  // Only a credential the service registry keeps in the store can hide there with no setting naming it.
  if (registry && target.serviceName && await storeUnreadable(deps, target)) return { value: null, declared: true, source: 'unreadable', ...configKeyOf(target) };
  return { value: null, declared: false, source: 'missing', ...configKeyOf(target) };
}

/** The words for a secret store this computer could not read while reading `target`, or null. */
export async function surfaceSecretStoreUnreadable(deps: SurfaceSecretReadDeps, label: string): Promise<string | null> {
  return unreadableSecretStore(deps.secretsManager as StoredSecretReader | undefined, STORE_CHECK_KEY, label);
}

const STORE_CHECK_KEY = 'GOODVIBES_STORE_READABLE_CHECK';

async function storeUnreadable(deps: SurfaceSecretReadDeps, target: ChannelSecretTargetDescriptor): Promise<boolean> {
  return (await surfaceSecretStoreUnreadable(deps, target.label)) !== null;
}

function configKeyOf(target: ChannelSecretTargetDescriptor): { readonly configKey?: string } {
  const key = target.configKeys?.[0];
  return key === undefined ? {} : { configKey: key };
}

function serviceBaseUrl(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const value = (entry as { readonly baseUrl?: unknown }).baseUrl;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The credential value, or null. */
export async function resolveSurfaceSecret(
  deps: SurfaceSecretReadDeps,
  surface: ChannelSurface,
  targetId: string,
): Promise<string | null> {
  return (await readSurfaceSecret(deps, surface, targetId)).value;
}

/**
 * The credential a send or an API call uses, or null when none is set. A
 * setting whose reference does not resolve throws naming the setting, so the
 * caller reports the broken reference instead of acting as another account or
 * as if nothing were configured.
 */
export async function requireSurfaceSecret(
  deps: SurfaceSecretReadDeps,
  surface: ChannelSurface,
  targetId: string,
): Promise<string | null> {
  const reading = await readSurfaceSecret(deps, surface, targetId);
  if (reading.source === 'unresolved') {
    throw new Error(`Could not resolve the ${surface} credential referenced by ${reading.configKey ?? targetId}`);
  }
  return reading.value;
}

/** The four ntfy topic names (each a credential), as the senders and the subscriber use them. */
export interface NtfyTopicNames {
  readonly topic: string;
  readonly chatTopic: string;
  readonly agentTopic: string;
  readonly remoteTopic: string;
}

/**
 * The ntfy topic names, each read like any other channel credential: its
 * setting holds a `goodvibes://secrets/` reference resolved through the
 * credential holder (one resolution per reference per process). An unset or
 * unreadable topic is empty.
 */
export async function readNtfyTopics(deps: SurfaceSecretReadDeps): Promise<NtfyTopicNames> {
  const [topic, chatTopic, agentTopic, remoteTopic] = await Promise.all(
    (['topic', 'chatTopic', 'agentTopic', 'remoteTopic'] as const).map(async (id) => (await resolveSurfaceSecret(deps, 'ntfy', id))?.trim() ?? ''),
  );
  return { topic: topic!, chatTopic: chatTopic!, agentTopic: agentTopic!, remoteTopic: remoteTopic! };
}

/** The secret-store key a target's value is kept under: its first environment name. */
function storeKeyFor(target: ChannelSecretTargetDescriptor): string {
  const key = target.envKeys?.[0];
  if (!key) throw new Error(`The ${target.surface} secret target '${target.id}' names no store key`);
  return key;
}

function configKeyFor(target: ChannelSecretTargetDescriptor): ConfigKey {
  const key = target.configKeys?.[0];
  if (!key) throw new Error(`The ${target.surface} secret target '${target.id}' names no config key`);
  return key as ConfigKey;
}

function goodVibesSecretUri(key: string): string {
  return `goodvibes://secrets/goodvibes/${encodeURIComponent(key)}`;
}

/**
 * Store a credential where every reader finds it: the value in the secret
 * store, and a reference to it in the target's config key.
 */
export async function storeSurfaceSecret(
  deps: SurfaceSecretWriteDeps,
  surface: ChannelSurface,
  targetId: string,
  value: string,
  scope: SecretScope,
): Promise<void> {
  const target = requireTarget(surface, targetId);
  const storeKey = storeKeyFor(target);
  await deps.secretsManager.set(storeKey, value, { scope: scope });
  deps.configManager.set(configKeyFor(target), goodVibesSecretUri(storeKey) as never);
}

/**
 * Remove a credential GoodVibes stored: the secret-store value, and the config
 * reference when the target names a setting (a webhook URL target has none).
 */
export async function clearSurfaceSecret(
  deps: SurfaceSecretWriteDeps,
  surface: ChannelSurface,
  targetId: string,
): Promise<void> {
  const target = requireTarget(surface, targetId);
  await deps.secretsManager.delete(storeKeyFor(target));
  const configKey = target.configKeys?.[0];
  if (configKey !== undefined) deps.configManager.set(configKey as ConfigKey, '' as never);
}

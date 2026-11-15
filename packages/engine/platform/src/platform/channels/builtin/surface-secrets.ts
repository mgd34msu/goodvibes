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
import { resolveSecretInput } from '../../config/secret-refs.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema.js';
import type { SecretScope, SecretsManager } from '../../config/secrets.js';
import type { ServiceSecretField } from '../../config/service-registry.js';
import type { ChannelSecretSource, ChannelSecretTargetDescriptor, ChannelSurface } from '../types.js';
import { getBuiltinSetupSchema } from './setup-schema.js';
import { channelCredentials } from '../credential-holder.js';

export interface SurfaceSecretReadDeps {
  readonly configManager: { get(key: string): unknown };
  readonly serviceRegistry: {
    resolveSecret(serviceName: string, field: ServiceSecretField): Promise<string | null>;
    /** The registry entry, when the registry can show it: a held credential is keyed by it. */
    get?(serviceName: string): unknown;
  };
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
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
 * Read one credential: the service registry, then each config key (a
 * `goodvibes://secrets/...` reference is resolved), then each environment
 * variable. A config value that resolves to nothing is still `declared`, which
 * is what lets status name the setting that points at a missing secret.
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
  if (target.serviceName && target.serviceField && SERVICE_FIELDS.has(target.serviceField)) {
    const serviceName = target.serviceName;
    const field = target.serviceField as ServiceSecretField;
    const registered = await channelCredentials.resolve(`service:${serviceName}:${field}`, deps.serviceRegistry.get?.(serviceName),
      () => deps.serviceRegistry.resolveSecret(serviceName, field), deps.secretsManager);
    if (registered) return { value: registered, declared: true, source: 'service-registry' };
  }
  let configDeclared = false;
  for (const key of target.configKeys ?? []) {
    const raw = deps.configManager.get(key);
    if (!present(raw)) continue;
    configDeclared = true;
    const secrets = deps.secretsManager;
    const resolved = await channelCredentials.resolve(`config:${key}`, raw, () => resolveSecretInput(raw, {
      ...(secrets ? { resolveLocalSecret: (name: string) => secrets.get(name) } : {}),
      homeDirectory: secrets?.getGlobalHome?.() ?? undefined,
    }), secrets);
    if (resolved) return { value: resolved, declared: true, source: 'config' };
  }
  for (const name of target.envKeys ?? []) {
    const value = process.env[name];
    if (value && value.trim()) return { value, declared: true, source: 'env' };
  }
  return { value: null, declared: configDeclared, source: configDeclared ? 'unresolved' : 'missing' };
}

/** The credential value, or null. */
export async function resolveSurfaceSecret(
  deps: SurfaceSecretReadDeps,
  surface: ChannelSurface,
  targetId: string,
): Promise<string | null> {
  return (await readSurfaceSecret(deps, surface, targetId)).value;
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

/** Remove a credential setup stored: the secret-store value and the config reference. */
export async function clearSurfaceSecret(
  deps: SurfaceSecretWriteDeps,
  surface: ChannelSurface,
  targetId: string,
): Promise<void> {
  const target = requireTarget(surface, targetId);
  await deps.secretsManager.delete(storeKeyFor(target));
  deps.configManager.set(configKeyFor(target), '' as never);
}

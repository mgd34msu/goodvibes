import { CONFIG_SCHEMA, type ConfigKey } from '../config/index.js';
import type { ProfileData } from './manager.js';

function setNestedValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current: Record<string, unknown> = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const existing = current[segment]!;
    if (!existing || typeof existing !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = structuredClone(value);
}

function getNestedValue(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Settings a profile never carries, in either direction. They decide what runs
 * without asking (approval behaviour), where the agent's instructions come from
 * and where its requests are routed, so applying a profile made on another host
 * or by someone else must not change them. Profiles are host display, model and
 * behaviour preferences only.
 */
const KEYS_NEVER_IN_A_PROFILE: ReadonlySet<string> = new Set([
  'behavior.autoApprove',
  'behavior.hitlMode',
  'provider.systemPromptFile',
  'provider.decisionRouter',
]);

function isProfileEntry(entry: (typeof CONFIG_SCHEMA)[number]): boolean {
  return (
    (entry.key.startsWith('display.') || entry.key.startsWith('provider.') || entry.key.startsWith('behavior.'))
    && !KEYS_NEVER_IN_A_PROFILE.has(entry.key)
  );
}

/** Whether a value read from a profile file is the kind of value the setting accepts. */
function acceptsValue(entry: (typeof CONFIG_SCHEMA)[number], value: unknown): boolean {
  switch (entry.type) {
    case 'boolean': if (typeof value !== 'boolean') return false; break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) return false; break;
    case 'string': if (typeof value !== 'string') return false; break;
    case 'enum': if (typeof value !== 'string' || !(entry.enumValues ?? []).includes(value)) return false; break;
    case 'object': if (!value || typeof value !== 'object' || Array.isArray(value)) return false; break;
  }
  return entry.validate ? entry.validate(value) : true;
}

export function configSnapshotToProfileData(snapshot: Record<string, unknown>): ProfileData {
  const profile: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    if (!isProfileEntry(entry)) continue;
    const value = snapshot[entry.key];
    if (value !== undefined) {
      setNestedValue(profile, entry.key.split('.'), value);
    }
  }
  return profile as ProfileData;
}

export function profileDataToConfigSnapshot(data: ProfileData): Partial<Record<ConfigKey, unknown>> {
  const snapshot: Partial<Record<ConfigKey, unknown>> = {};
  for (const entry of CONFIG_SCHEMA) {
    if (!isProfileEntry(entry)) continue;
    // A profile file is read from disk unchecked: a value of the wrong kind, or one
    // outside the setting's own rule, is left out rather than handed on.
    const value = getNestedValue(data, entry.key.split('.'));
    if (value !== undefined && acceptsValue(entry, value)) snapshot[entry.key] = structuredClone(value);
  }
  return snapshot;
}

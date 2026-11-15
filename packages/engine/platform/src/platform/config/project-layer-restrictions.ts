/**
 * What a project settings file may NOT do.
 *
 * The project file lives inside the working directory, so it is repository
 * content: whoever authored the repository wrote it, not necessarily the person
 * opening it. Workspace trust only gates the ask layer, so a project value that
 * makes the permission machinery approve on its own, or that points a secret at
 * a command or a destination at a foreign host, would take effect before any
 * trust question is raised.
 *
 * The rule is one-directional: a project file may make the posture stricter than
 * the user's own settings, never looser, and it may not carry the keys declared
 * not project-settable at all. Both facts come from config-key-facts.ts, which
 * the settings writer and the gate read too. A refused value stays in the file
 * untouched and is reported through an ingestion notice; the owner who wants it
 * applies it from their own settings.
 */
import { deleteRawDotPath } from './settings-io.js';
import { readDotPath } from './shared-config-tier.js';
import { normalizeSecretRef } from './secret-refs.js';
import type { SettingsIngestionNotice } from './settings-ingestion.js';
import { configKeyFacts, listProjectUnsettableConfigKeys } from './config-key-facts.js';

export { isProjectRestrictedKey } from './config-key-facts.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExecSecretRef(value: unknown): boolean {
  if (typeof value !== 'string' && !(isPlainObject(value) && ('source' in value || 'provider' in value || 'type' in value))) return false;
  return normalizeSecretRef(value)?.source === 'exec';
}

function collectLeaves(value: unknown, path: string, out: Array<{ path: string; value: unknown }>): void {
  if (isPlainObject(value) && !isExecSecretRef(value)) {
    for (const [field, child] of Object.entries(value)) collectLeaves(child, path ? `${path}.${field}` : field, out);
    return;
  }
  out.push({ path, value });
}

/**
 * Remove from a freshly ingested project layer every value that would loosen the
 * posture already established by `current` (the merged defaults and user file).
 * Mutates and returns the layer.
 */
export function restrictProjectLayer(
  layer: Record<string, unknown>,
  current: unknown,
  file: string,
): { readonly layer: Record<string, unknown>; readonly notices: SettingsIngestionNotice[] } {
  const notices: SettingsIngestionNotice[] = [];
  const refuse = (key: string, reason: string): void => {
    deleteRawDotPath(layer, key);
    notices.push({
      file, key, action: 'skipped', reason,
      remedy: 'Set it in your own settings file; a project settings file can only make this stricter',
    });
  };
  const userValue = (key: string): unknown => readDotPath(current, key).value;

  for (const key of listProjectUnsettableConfigKeys()) {
    if (readDotPath(layer, key).present) refuse(key, 'a project settings file cannot set where data or judgment calls are sent');
  }

  const leaves: Array<{ path: string; value: unknown }> = [];
  collectLeaves(layer, '', leaves);
  const refused = new Set<string>();
  for (const leaf of leaves) {
    if (!leaf.path) continue;
    const facts = configKeyFacts(leaf.path);
    if (facts.loosens?.(userValue(leaf.path), leaf.value)) {
      refused.add(leaf.path);
      refuse(leaf.path, `a project settings file cannot ${facts.loosening ?? 'loosen this setting'}`);
    }
  }
  for (const leaf of leaves) {
    if (leaf.path && !refused.has(leaf.path) && isExecSecretRef(leaf.value)) {
      refuse(leaf.path, 'a project settings file cannot reference a secret read by running a command');
    }
  }
  return { layer, notices };
}

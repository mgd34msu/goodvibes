/**
 * What a project settings file may do.
 *
 * The project file lives inside the working directory, so it is repository
 * content: whoever authored the repository wrote it, not necessarily the person
 * opening it, and it is read before any trust question is raised. So the
 * project layer admits only the keys declared project-settable
 * (config-key-facts.ts: presentation, behaviour inside the project, contract
 * and worktree runs, and the permission posture in the stricter direction).
 * Every other key, including a key the schema does not know and a surface's
 * own setting not declared for projects (a status-line command), is skipped.
 * The facts come from the same declarations the settings writer and the gate
 * read. A skipped value stays in the file untouched and is reported through an
 * ingestion notice; the owner who wants it applies it from their own settings.
 */
import { deleteRawDotPath } from './settings-io.js';
import { readDotPath } from './shared-config-tier.js';
import { normalizeSecretRef } from './secret-refs.js';
import type { SettingsIngestionNotice } from './settings-ingestion.js';
import { configKeyFacts, listProjectUnsettableConfigKeys } from './config-key-facts.js';
import { CONFIG_KEYS } from './schema.js';

export { isProjectRestrictedKey } from './config-key-facts.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A secret reference other than a name in the owner's store. Every other source
 * reads a file, an environment variable or runs a program, which repository
 * content must not choose.
 */
function isForeignSecretRef(value: unknown): boolean {
  if (typeof value !== 'string' && !(isPlainObject(value) && ('source' in value || 'provider' in value || 'type' in value))) return false;
  const source = normalizeSecretRef(value)?.source;
  return source !== undefined && source !== 'goodvibes';
}

function collectLeaves(value: unknown, path: string, out: Array<{ path: string; value: unknown }>): void {
  if (isPlainObject(value) && !isForeignSecretRef(value)) {
    for (const [field, child] of Object.entries(value)) collectLeaves(child, path ? `${path}.${field}` : field, out);
    return;
  }
  out.push({ path, value });
}

/**
 * The setting a leaf of the project file belongs to: the leaf itself when it is
 * a schema key or a surface's own setting, else the nearest schema key above it
 * (an object-valued setting such as a price table), else the leaf as written
 * (a per-tool permission, or a key nothing declares).
 */
function settingFor(path: string, isHostSetting: (key: string) => boolean): string {
  if (CONFIG_KEYS.has(path) || isHostSetting(path)) return path;
  for (let end = path.lastIndexOf('.'); end > 0; end = path.lastIndexOf('.', end - 1)) {
    const parent = path.slice(0, end);
    if (CONFIG_KEYS.has(parent)) return parent;
  }
  return path;
}

/** What the project layer is checked against besides the schema. */
export interface ProjectLayerHostSettings {
  /** True for a surface's own registered setting (host-settings.ts). */
  readonly has: (key: string) => boolean;
  /** True when that setting is declared settable from a project file. */
  readonly projectSettable: (key: string) => boolean;
}

const NO_HOST_SETTINGS: ProjectLayerHostSettings = { has: () => false, projectSettable: () => false };

/**
 * Keep in a freshly ingested project layer only what a project file may set:
 * keys declared project-settable, and of those the ones with a loosening rule
 * only when they are no looser than `current` (the merged defaults and user
 * file). Mutates and returns the layer.
 */
export function restrictProjectLayer(
  layer: Record<string, unknown>,
  current: unknown,
  file: string,
  host: ProjectLayerHostSettings = NO_HOST_SETTINGS,
): { readonly layer: Record<string, unknown>; readonly notices: SettingsIngestionNotice[] } {
  const notices: SettingsIngestionNotice[] = [];
  const refused = new Set<string>();
  const refuse = (key: string, reason: string, remedy = 'Set it in your own settings file; a project settings file can only make this stricter'): void => {
    if (refused.has(key)) return;
    refused.add(key);
    deleteRawDotPath(layer, key);
    notices.push({ file, key, action: 'skipped', reason, remedy });
  };
  const userValue = (key: string): unknown => readDotPath(current, key).value;
  const elsewhere = 'Set it in your own settings file if you want it; a project settings file is repository content';

  for (const key of listProjectUnsettableConfigKeys()) {
    if (readDotPath(layer, key).present) refuse(key, 'a project settings file cannot set where data or judgment calls are sent', elsewhere);
  }

  const leaves: Array<{ path: string; value: unknown }> = [];
  collectLeaves(layer, '', leaves);
  for (const leaf of leaves) {
    if (!leaf.path) continue;
    const key = settingFor(leaf.path, (path) => host.has(path));
    if (refused.has(key)) continue;
    if (host.has(key)) {
      if (!host.projectSettable(key)) refuse(key, `a project settings file cannot set ${key}, a setting of this program that is not declared for projects`, elsewhere);
      continue;
    }
    const facts = configKeyFacts(key);
    // A project's own worktree setup commands are not a setting of this program: the daemon runs them for that
    // project's worktrees, and only once the owner trusts the folder (runtime/worktree/project-setup-settings.ts).
    if (key === 'worktree.setup.commands') {
      refuse(key, 'the project\'s own worktree setup commands are not a setting here: the daemon runs them when it sets up this project\'s worktrees, and only once you trust this folder',
        '"Trust this folder" in Permissions and safety, This folder, lets them run; keep it restricted to keep them off');
      continue;
    }
    if (!facts.projectSettable) {
      refuse(key, facts.inSchema
        ? `a project settings file cannot set ${key}; it can set only display, behaviour, contract, worktree and stricter permission settings`
        : `${key} is not a setting a project settings file can carry`, elsewhere);
      continue;
    }
    if (facts.loosens?.(userValue(key), readDotPath(layer, key).value)) {
      refuse(key, `a project settings file cannot ${facts.loosening ?? 'loosen this setting'}`);
    } else if (isForeignSecretRef(leaf.value)) {
      refuse(key, 'a project settings file can reference only a named key in your secret store (goodvibes://secrets/goodvibes/<KEY>), never a file, an environment variable or a password-manager command', elsewhere);
    }
  }
  return { layer, notices };
}

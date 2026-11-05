import { readFileSync } from 'node:fs';
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { CONFIG_SCHEMA } from '../../config/schema.js';
import { READ_SECRETS_SITE } from '../../permissions/credential-read-defaults.js';
import { effectivePermissionMode, gatePresetLabel } from '../presets.js';

// ---------------------------------------------------------------------------
// /permissions provenance panel.
//
// Shows every permission-relevant setting in effect AND where each value came
// from. Provenance is taken from the platform's own ConfigManager.
// describeConfigKeySource (the recorded on-disk tier: shared / project / global
// / default), never a guess. Because CLI --config overrides mutate the config
// in memory WITHOUT touching any file, we additionally compare the live value
// against the recorded on-disk / built-in-default value: when they diverge, the
// value was changed at runtime and its true origin is NOT recorded on disk, so
// the line is labelled exactly that rather than mis-attributed to a file.
//
// Hoisted from the TUI (src/input/commands/permissions-provenance.ts) into the
// engine gate; the rendered text is unchanged.
// ---------------------------------------------------------------------------

/** A permission-relevant setting, its live value, and where that value came from. */
export interface PermissionProvenanceRow {
  readonly key: string;
  readonly label: string;
  /** The effective (live) value the running session uses. */
  readonly value: unknown;
  /** Human origin: a config file + path, "built-in default", or an "origin not recorded" label. */
  readonly origin: string;
  readonly originPath: string | null;
  /** False when the origin is genuinely not recorded anywhere (runtime override, unreadable file, unknown key). */
  readonly recorded: boolean;
  /** True when the live value diverges from the recorded on-disk / default value (an in-memory runtime override). */
  readonly overridden: boolean;
  /** The recorded on-disk / default value, shown alongside the effective value when overridden. */
  readonly recordedValue?: unknown;
  readonly note?: string;
}

export interface PermissionProvenance {
  readonly sessionMode: string;
  readonly sessionModeLabel: string;
  readonly rows: readonly PermissionProvenanceRow[];
  readonly readSecretsSite: string;
}

/** The permission-relevant settings, in the order the panel lists them. */
const PERMISSION_KEYS: readonly { readonly key: string; readonly label: string; readonly note?: string }[] = [
  { key: 'permissions.mode', label: 'Execution mode' },
  { key: 'permissions.engine', label: 'Permission evaluator', note: 'baseline or policy-engine' },
  ...CONFIG_SCHEMA.filter(setting => setting.key.startsWith('permissions.tools.') && !setting.deprecated).map(setting => ({
    key: setting.key, label: `Tool restriction: ${setting.key.slice('permissions.tools.'.length)}`,
    note: 'Deny restricts safe execution modes; other values follow the selected mode.',
  })),
];

/** Read a dotted key out of a parsed JSON object; segments may themselves contain hyphens. */
function readDotPath(obj: unknown, key: string): { present: boolean; value: unknown } {
  let cursor: unknown = obj;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object' || !(part in (cursor as object))) {
      return { present: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return { present: true, value: cursor };
}

/** The value a config key resolves to from a single on-disk file, or null when the file is unreadable. */
function fileValue(path: string, key: string): { present: boolean; value: unknown } | null {
  try {
    return readDotPath(JSON.parse(readFileSync(path, 'utf-8')), key);
  } catch {
    return null;
  }
}

function schemaDefault(key: string): { known: boolean; value: unknown } {
  const setting = CONFIG_SCHEMA.find((s) => s.key === key);
  return setting ? { known: true, value: setting.default } : { known: false, value: undefined };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type ConfigProvenanceManager = Pick<ConfigManager, 'get' | 'describeConfigKeySource' | 'getConfigPath' | 'getProjectConfigPath'>;

function buildRow(
  configManager: ConfigProvenanceManager,
  entry: { key: string; label: string; note?: string },
): PermissionProvenanceRow {
  const { key, label, note } = entry;
  let live: unknown;
  try {
    live = configManager.get(key as ConfigKey);
  } catch {
    live = undefined;
  }

  let src: ReturnType<ConfigManager['describeConfigKeySource']> | null = null;
  try {
    src = configManager.describeConfigKeySource(key as ConfigKey);
  } catch {
    src = null;
  }

  const base = { key, label, value: live, ...(note ? { note } : {}) };

  // No recorded tier for this key (e.g. a feature-flag key outside the typed schema).
  if (!src) {
    return { ...base, origin: 'origin not recorded (key is outside the config schema)', originPath: null, recorded: false, overridden: false };
  }

  const tier = src.tier;
  const globalPath = configManager.getConfigPath();
  const projectPath = configManager.getProjectConfigPath();
  const originPath = tier === 'daemon' ? src.daemonTierPath
    : tier === 'shared' ? src.sharedTierPath
    : tier === 'project' ? (projectPath ?? null)
    : tier === 'global' ? globalPath
    : null;

  // Runtime-aware managers report accepted snapshot provenance, including a
  // last-good value after refusal. Never mislabel an unaccepted disk edit as
  // the live origin by rereading the file here.
  if (src.effectiveOrigin) {
    if (src.effectiveOrigin === 'runtime' || src.effectiveOrigin === 'runtime-default') {
      return { ...base, origin: src.effectiveOrigin === 'runtime' ? 'runtime override (in-memory; origin not recorded on disk)' : 'frontend runtime default',
        originPath: null, recorded: false, overridden: src.effectiveOrigin === 'runtime' };
    }
    return { ...base, origin: tier === 'default' ? 'built-in default' : `${tier} config file`,
      originPath, recorded: true, overridden: false, recordedValue: live };
  }

  // The value the recorded layer actually holds on disk (or the built-in default).
  let recordedValue: unknown;
  let recordedSource: string;
  if (tier === 'default') {
    const def = schemaDefault(key);
    recordedValue = def.value;
    recordedSource = def.known ? 'built-in default' : 'built-in default (not in schema)';
  } else if (originPath) {
    const fv = fileValue(originPath, key);
    if (!fv || !fv.present) {
      // The tier says this file carries the key, but we could not read it back,
      // do not guess; report the origin as unrecorded.
      return { ...base, origin: `origin not recorded (${tier} config file could not be read back)`, originPath, recorded: false, overridden: false };
    }
    recordedValue = fv.value;
    recordedSource = `${tier} config file`;
  } else {
    return { ...base, origin: `origin not recorded (no path for ${tier} tier)`, originPath: null, recorded: false, overridden: false };
  }

  const overridden = !sameValue(live, recordedValue);
  if (overridden) {
    // A CLI --config override (or any in-memory set that did not persist) sits on
    // top of the recorded value. There is no on-disk record of where it came from.
    return {
      ...base,
      origin: 'runtime override (in-memory; origin not recorded on disk)',
      originPath,
      recorded: false,
      overridden: true,
      recordedValue,
    };
  }

  return { ...base, origin: recordedSource, originPath, recorded: true, overridden: false, recordedValue };
}

export function buildPermissionProvenance(configManager: ConfigProvenanceManager): PermissionProvenance {
  const savedAutoApprove = configManager.get('behavior.autoApprove');
  const mode = effectivePermissionMode(configManager.get('permissions.mode'), savedAutoApprove === true);
  return {
    sessionMode: mode,
    sessionModeLabel: gatePresetLabel(mode),
    rows: [
      ...PERMISSION_KEYS.map((entry) => buildRow(configManager, entry)),
      ...(savedAutoApprove === true ? [buildRow(configManager, {
        key: 'behavior.autoApprove', label: 'Saved YOLO alias',
        note: 'Legacy saved setting selects YOLO. Selecting an execution mode clears this alias.',
      })] : []),
    ],
    readSecretsSite: READ_SECRETS_SITE,
  };
}

function displayValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : value;
  return JSON.stringify(value);
}

/** Render the provenance panel as plain lines for the command surface. */
export function renderPermissionProvenance(provenance: PermissionProvenance): string {
  const lines: string[] = [
    'Permissions: settings in effect and where each came from',
    `  session mode: ${provenance.sessionMode} (${provenance.sessionModeLabel})`,
    '',
    'Every line is traceable to its recorded origin. A value changed at runtime',
    '(e.g. via --config) is not recorded on disk and is labelled as such.',
    '',
  ];
  const keyWidth = Math.max(...provenance.rows.map((r) => r.label.length));
  for (const row of provenance.rows) {
    const flag = row.overridden ? ' *' : row.recorded ? '' : ' ?';
    const valueText = displayValue(row.value);
    lines.push(`  ${row.label.padEnd(keyWidth)} : ${valueText}${flag}`);
    if (row.overridden) {
      lines.push(`  ${' '.repeat(keyWidth)}   origin: ${row.origin}`);
      lines.push(`  ${' '.repeat(keyWidth)}   on disk: ${displayValue(row.recordedValue)} (${row.originPath ?? 'no file'})`);
    } else {
      const pathText = row.originPath ? ` (${row.originPath})` : '';
      lines.push(`  ${' '.repeat(keyWidth)}   origin: ${row.origin}${pathText}`);
    }
    if (row.note) lines.push(`  ${' '.repeat(keyWidth)}   note: ${row.note}`);
  }
  lines.push('');
  lines.push('  Legend: * = runtime override (not recorded on disk)   ? = origin not recorded');
  lines.push('  Tiers: shared / project / global config file, or the built-in default.');

  lines.push('');
  lines.push(`Read-only secret-material checks: ${provenance.readSecretsSite}`);
  lines.push('Safe modes use the shared secret-material reading; uncertain readings use the full permission gate.');
  lines.push('YOLO skips execution safety readings and approval prompts.');

  return lines.join('\n');
}

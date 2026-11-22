import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { CONFIG_SCHEMA } from '../../config/schema.js';
import { READ_SECRETS_SITE } from '../../permissions/credential-read-defaults.js';
import { effectivePermissionMode, gatePresetLabel } from '../presets.js';
import { describePermissionModeInForce, type PermissionModeInForce } from '../../permissions/decision-model-readiness.js';

// ---------------------------------------------------------------------------
// /permissions provenance panel.
//
// Shows every permission-relevant setting in effect AND where each value came
// from, as the ConfigManager accepted it (describeConfigKeySource: the tier and
// the effective origin), never by rereading a file. A value overridden at
// runtime (--config) names the tier underneath it and that tier's file. The
// evaluator row also shows the evaluator in force, which changes only at a
// restart.
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
  /** For a runtime override: the tier the accepted settings hold underneath it. */
  readonly underlay?: string;
  /** Set when the value in force differs from the configured one until a restart. */
  readonly inForce?: string;
  readonly note?: string;
}

export interface PermissionProvenance {
  /** The mode chosen: the saved default, or the mode chosen for this session (Shift+Tab, `--config`). */
  readonly sessionMode: string;
  readonly sessionModeLabel: string;
  /** The saved default under a mode chosen for this session; absent when the session runs the saved default. */
  readonly savedMode?: string;
  /** The mode the gate decides calls by now. */
  readonly modeInForce: string;
  readonly modeInForceLabel: string;
  /** Why the mode in force is not the chosen one; absent when they are the same. */
  readonly modeInForceReason?: string;
  readonly rows: readonly PermissionProvenanceRow[];
  readonly readSecretsSite: string;
}

/** The permission-relevant settings, in the order the panel lists them. */
const PERMISSION_KEYS: readonly { readonly key: string; readonly label: string; readonly note?: string }[] = [
  { key: 'permissions.mode', label: 'When GoodVibes asks' },
  { key: 'permissions.engine', label: 'Permission evaluator', note: 'baseline or policy-engine' },
  ...CONFIG_SCHEMA.filter(setting => setting.key.startsWith('permissions.tools.') && !setting.deprecated).map(setting => ({
    key: setting.key, label: `Tool restriction: ${setting.key.slice('permissions.tools.'.length)}`,
    note: 'Deny restricts safe execution modes; other values follow the selected mode.',
  })),
];

export type ConfigProvenanceManager = Pick<ConfigManager, 'get' | 'describeConfigKeySource' | 'getConfigPath' | 'getProjectConfigPath'>
  & Partial<Pick<ConfigManager, 'getSavedValue' | 'isExplicitlySet'>>;

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

  const tierLabel = tier === 'default' ? 'built-in default' : `${tier} config file`;
  if (src.effectiveOrigin === 'runtime') {
    return { ...base, origin: 'runtime override (in-memory; origin not recorded on disk)', originPath, recorded: false, overridden: true, underlay: tierLabel };
  }
  if (src.effectiveOrigin === 'runtime-default') {
    return { ...base, origin: 'frontend runtime default', originPath: null, recorded: false, overridden: false };
  }
  return { ...base, origin: tierLabel, originPath, recorded: true, overridden: false };
}

/** What the running process uses for the evaluator, when the surface can say. */
export interface PermissionProvenanceOptions {
  readonly evaluatorInForce?: 'baseline' | 'policy-engine' | undefined;
  /** The mode in force as the surface's own owner reports it (a hosted session's host); read from settings when absent. */
  readonly modeInForce?: PermissionModeInForce | undefined;
}

export function buildPermissionProvenance(configManager: ConfigProvenanceManager, options: PermissionProvenanceOptions = {}): PermissionProvenance {
  const savedAutoApprove = configManager.get('behavior.autoApprove');
  // The mode the gate decides by, read by the same rule the gate reads (decision-model-readiness.ts).
  const inForce = options.modeInForce ?? describePermissionModeInForce(configManager);
  const mode = options.modeInForce?.chosen ?? effectivePermissionMode(configManager.get('permissions.mode'), savedAutoApprove === true);
  const saved = configManager.getSavedValue
    ? effectivePermissionMode(configManager.getSavedValue('permissions.mode'), configManager.getSavedValue('behavior.autoApprove') === true)
    : mode;
  const withInForce = (row: PermissionProvenanceRow): PermissionProvenanceRow =>
    row.key === 'permissions.engine' && options.evaluatorInForce !== undefined && options.evaluatorInForce !== row.value
      ? { ...row, inForce: `${options.evaluatorInForce} until restart (restart to apply ${String(row.value)})` }
      : row;
  return {
    sessionMode: mode,
    sessionModeLabel: gatePresetLabel(mode),
    ...(saved !== mode ? { savedMode: saved } : {}),
    modeInForce: inForce.mode,
    modeInForceLabel: gatePresetLabel(inForce.mode),
    ...(inForce.reason !== undefined ? { modeInForceReason: inForce.reason } : {}),
    rows: [
      ...PERMISSION_KEYS.map((entry) => withInForce(buildRow(configManager, entry))),
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
    `  mode in force: ${provenance.modeInForce} (${provenance.modeInForceLabel})`,
    ...(provenance.modeInForceReason !== undefined
      ? [`    not ${provenance.sessionMode}, because ${provenance.modeInForceReason}`] : []),
    provenance.savedMode !== undefined
      ? `  chosen for this session: ${provenance.sessionMode} (${provenance.sessionModeLabel}); saved default: ${provenance.savedMode} (set in /settings)`
      : `  saved mode: ${provenance.sessionMode} (${provenance.sessionModeLabel})`,
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
      if (row.underlay) lines.push(`  ${' '.repeat(keyWidth)}   underneath: ${row.underlay}${row.originPath ? ` (${row.originPath})` : ''}`);
    } else {
      const pathText = row.originPath ? ` (${row.originPath})` : '';
      lines.push(`  ${' '.repeat(keyWidth)}   origin: ${row.origin}${pathText}`);
    }
    if (row.inForce) lines.push(`  ${' '.repeat(keyWidth)}   in force: ${row.inForce}`);
    if (row.note) lines.push(`  ${' '.repeat(keyWidth)}   note: ${row.note}`);
  }
  lines.push('');
  lines.push('  Legend: * = runtime override (not recorded on disk)   ? = origin not recorded');
  lines.push('  Tiers: shared / project / global config file, or the built-in default.');

  lines.push('');
  lines.push(`Read-only secret-material checks: ${provenance.readSecretsSite}`);
  lines.push('Safe modes use the shared secret-material reading; uncertain readings use the full permission gate.');
  lines.push('YOLO skips execution safety readings and approval prompts; never-run rules and Pre:tool hooks still apply.');

  return lines.join('\n');
}

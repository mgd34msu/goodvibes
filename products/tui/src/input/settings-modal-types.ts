import type { CommonSettingsCategory, CommonSettingEntryState } from '@goodvibes-jev/engine/terminal-shell/settings-model-types';
import type { ConfigSetting, HostBooleanSetting } from '@goodvibes-jev/engine/platform/platform/config';
import type { FeatureFlag, FeatureSetting, FlagState } from '@/runtime/index.ts';

export type SettingsCategory = CommonSettingsCategory | 'wrfc' | 'connections';

export type { SettingsFocusRegion } from '@goodvibes-jev/engine/terminal-shell/settings-model-types';

export const SETTINGS_CATEGORY_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly categories: readonly SettingsCategory[];
}> = [
  { label: 'Interface', categories: ['display', 'ui', 'behavior', 'notifications', 'permissions', 'policy', 'security'] },
  { label: 'AI Routing', categories: ['provider', 'pricing', 'subscriptions', 'judgment', 'helper', 'tools', 'tts', 'voice'] },
  { label: 'Service & Network', categories: ['service', 'daemon', 'network', 'controlPlane', 'httpListener', 'web', 'relay'] },
  // 'hostedSessions' sits beside 'surfaces' and 'conversationGate': all three
  // answer "where does this conversation actually run, and who can reach it",
  // the detach policy is a fact about the daemon holding a session open, not
  // about this terminal's presentation of it.
  // 'email', 'calendar' and 'google' sit beside 'surfaces': they configure
  // the daemon's connections to the owner's mail and calendar, where those
  // services reach the world, not how this terminal presents anything.
  {
    label: 'Surfaces & Cloud',
    categories: [
      'surfaces',
      'hostedSessions',
      'device',
      'conversationGate',
      'integrations',
      'connections',
      'email',
      'calendar',
      'google',
      'mcp',
      'cloudflare',
    ],
  },
  // 'occasions' sits beside 'checkin': both are proactive background loops
  // (a cadence, a judgment pass, a conditional channel delivery) rather than
  // facts held about the owner, the data occasions/plans declare lives in
  // the owner profile file itself (docs/occasions.md §3), but these SETTINGS
  // rows tune the loop, exactly like checkin's.
  {
    label: 'Automation',
    categories: ['batch', 'automation', 'checkin', 'occasions', 'watchers', 'orchestration', 'planner', 'contract', 'wrfc', 'payments'],
  },
  // 'profile' sits beside 'memory' and 'learning': all three are what the
  // platform retains about the person using it, and this is the group a reader
  // looking for "what does it know about me" already scans, Interface is
  // presentation and permission posture, and nothing there is a store of facts.
  {
    label: 'Runtime & Data',
    categories: [
      'storage',
      'atRest',
      'sandbox',
      'fetch',
      'agents',
      'runtime',
      'power',
      'profile',
      'memory',
      'cache',
      'telemetry',
      'diagnostics',
      'learning',
    ],
  },
  { label: 'Advanced', categories: ['release', 'update', 'danger'] },
];

export const SETTINGS_CATEGORIES: SettingsCategory[] = SETTINGS_CATEGORY_GROUPS.flatMap((group) => group.categories);

/** Builtin and host rows keep their distinct public platform key contracts. */
export type SettingEntry = BuiltinSettingEntry | HostSettingEntry;

export interface BuiltinSettingEntry extends SettingEntryState {
  kind?: 'builtin';
  setting: ConfigSetting;
}

export interface HostSettingEntry extends SettingEntryState {
  kind: 'host';
  setting: HostBooleanSetting & { readonly enumValues?: never };
  currentValue: boolean;
}

interface SettingEntryState extends CommonSettingEntryState {
  valueUnavailable?: string;
  flag?: FlagEntry;
  ownerFlagId?: string;
}

export interface FlagEntry {
  /** The per-feature settings metadata (domain, enablement shape, settings keys, real description). */
  feature: FeatureSetting;
  /** The internal gate declaration (kill state/reason live here). */
  flag: FeatureFlag;
  /** Live effective state as the runtime currently sees it. */
  state: FlagState;
  /**
   * Last known config-layer (persisted) value. Equals `state` unless a
   * startup-gated feature was changed this session, then it holds the value
   * that will take effect on the next launch.
   */
  persistedState: FlagState;
  /**
   * True when a startup-gated feature's persisted value differs from its
   * effective state, i.e. a restart is required before the change takes
   * effect. Sourced from FeatureFlagManager.getAll(), never guessed.
   */
  pendingRestart: boolean;
}

export type { McpEntry } from '@goodvibes-jev/engine/terminal-shell/settings-model-types';

export type { SubscriptionEntry } from '@goodvibes-jev/engine/terminal-shell/settings-subscriptions';

import type {
  CommonSettingsCategory,
  CommonSettingEntryState,
  SettingsValueSource,
  SettingsModalChangeHandler,
} from '@goodvibes-jev/engine/terminal-shell/settings-model-types';
import type { AgentConfigSetting } from '../config/settings-catalog.ts';

import type { FeatureSetting, FlagState } from '@/runtime/index.ts';

export type { SettingsModalChange } from '@goodvibes-jev/engine/terminal-shell/settings-model-types';

export type { SettingsModalChangeResult } from '@goodvibes-jev/engine/terminal-shell/settings-model-types';

export type { SettingsModalChangeHandler } from '@goodvibes-jev/engine/terminal-shell/settings-model-types';

export interface SettingsModalOpenOptions {
  readonly onSettingApplied?: SettingsModalChangeHandler;
  /** Repaint after a registered host preference changes outside this modal. */
  readonly requestRender?: () => void;
}

export type SettingsCategory = CommonSettingsCategory | 'flags' | 'fleet' | 'cluster';

export type { SettingsFocusRegion as SettingsFocusPane } from '@goodvibes-jev/engine/terminal-shell/settings-model-types';

/**
 * Config-key roots that have no category of their own, and the category each
 * one is listed under instead.
 *
 * A setting's category is normally its key's first segment, so a root with no
 * matching category matches nothing and its keys are dropped from the
 * workspace entirely, present in the schema, read by the daemon, and reachable
 * only by hand-editing the config file. Anything listed here is deliberately
 * shown somewhere it makes sense to a reader instead.
 *
 * `push`, the VAPID contact address and the subscription housekeeping bounds
 * describe how a notification is DELIVERED, so they sit with the
 * `notifications.*` keys that decide which events are pushed in the first
 * place.
 *
 * `cluster`, heartbeat timing, the multicast group, the shared secret and the
 * key-rotation windows all describe how this node finds and trusts its peers.
 * That is the same subject `fleet.*` already covers, so they are listed
 * together rather than under a category of their own.
 */
export const CROSS_LISTED_SETTING_ROOTS: Readonly<Record<string, SettingsCategory>> = {
  push: 'notifications',
  cluster: 'fleet',
};

export const SETTINGS_CATEGORY_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly categories: readonly SettingsCategory[];
}> = [
  // `profile` sits with the other categories that decide how the Agent treats
  // HIM: whether it learns what he tells it about himself, whether it says what
  // it recorded, and whether the few harmless facts (his city, his timezone,
  // how he likes replies written) ride along on a turn. That is the same
  // subject `behavior`, `policy` and `permissions` already cover, and the keys
  // are daemon-owned like several others already listed here, so the group's
  // membership does not turn on which process stores the value.
  //
  // `payments` sits here rather than under "Daemon Runtime" for the same
  // reason: every other key in that group is transport, binding, or
  // coordination plumbing with nothing for the owner to weigh, while a purchase
  // budget, shipping preference and CVV trade-off are decisions he makes about
  // the Agent's behavior. It is daemon-owned (config-ownership.ts) like
  // `cluster` is, but that is a routing fact about where the write lands, not a
  // reason to file it away from the settings he actually thinks about.
  //
  // `occasions` sits beside `profile` for the same reason and a stronger one:
  // the occasions and plans it governs ARE prose lines in the profile file
  // (docs/occasions.md §3), so filing them apart would put one document's
  // settings in two places. What they decide is also the same kind of thing,
  // how far ahead the Agent raises a birthday, whether it writes his dates out
  // to a calendar, how many questions the gift interview asks. Daemon-owned like
  // `profile` and `payments`, which is a routing fact about where the write
  // lands rather than a reason to file it away from the settings he weighs.
  {
    label: 'Agent Experience',
    categories: [
      'display',
      'ui',
      'behavior',
      'profile',
      'occasions',
      'agents',
      'notifications',
      'permissions',
      'policy',
      'fetch',
      'diagnostics',
      'power',
      'payments',
    ],
  },
  { label: 'Models and Providers', categories: ['provider', 'judgment', 'subscriptions', 'helper', 'tools', 'tts', 'voice', 'pricing'] },
  { label: 'Agent-local state', categories: ['storage', 'cache', 'telemetry', 'atRest', 'security', 'learning'] },
  // `email`, `calendar` and `google` sit beside `surfaces` for the reason
  // `surfaces` is here at all: they configure where the daemon's services reach
  // the world, the mailbox it composes and sends through, the calendars it
  // reads and writes, and the Google OAuth record the two share, rather than
  // anything about how this terminal presents them. Daemon-owned, like several
  // other categories in this group.
  {
    label: 'Channels and Tools',
    categories: [
      'surfaces',
      'conversationGate',
      'hostedSessions',
      'device',
      'email',
      'calendar',
      'google',
      'mcp',
      'automation',
      'checkin',
      'integrations',
    ],
  },
  // `danger` sits with the other listener/binding categories because that is
  // what it is: danger.httpListener opens an inbound webhook listener. It is
  // rendered like any other setting rather than hidden, the write is gated by
  // the narrow confirmation list in src/tools/agent-settings-write-policy.ts,
  // which can name the key and state the hazard. A hidden key cannot.
  // `cluster` belongs here rather than being hidden. The Agent composes no
  // inbound channel consumer of its own, a guard test holds that, so it is
  // never a candidate in an election. But every cluster.* key is DAEMON-owned
  // (the platform's config-ownership.ts), so a write from this surface routes to the
  // daemon that acts on it, exactly like every other key in this group. Hiding
  // them would leave the owner unable to configure which of his machines reads
  // the inbox from the surface he actually uses, which is the same mistake the
  // retired host-owned lock made.
  {
    label: 'Daemon Runtime',
    categories: ['daemon', 'service', 'controlPlane', 'httpListener', 'danger', 'web', 'watchers', 'network', 'relay', 'cluster', 'update'],
  },
  {
    label: 'Advanced Runtime',
    categories: ['orchestration', 'fleet', 'planner', 'runtime', 'sandbox', 'batch', 'cloudflare', 'contract', 'memory'],
  },
  { label: 'Advanced', categories: ['flags', 'release'] },
];

export const SETTINGS_CATEGORIES: SettingsCategory[] = SETTINGS_CATEGORY_GROUPS.flatMap((group) => group.categories);

export interface SettingEntry extends CommonSettingEntryState<SettingsValueSource | 'unavailable'> {
  setting: AgentConfigSetting;
}

export interface FlagEntry {
  /** The feature as FEATURE_SETTINGS describes it: domain, enablement shape, settings keys, real description. */
  feature: FeatureSetting;
  /** Live gate state from the manager (kill-switch aware); config-derived when no manager is attached. */
  state: FlagState;
  /** The enablement settings key's current config value, rendered on the row. */
  enablementValue: string;
}

export type { McpEntry } from '@goodvibes-jev/engine/terminal-shell/settings-model-types';

export type { SubscriptionEntry } from '@goodvibes-jev/engine/terminal-shell/settings-subscriptions';

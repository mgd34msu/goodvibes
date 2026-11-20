/**
 * The seven settings topics, one list for the terminal programs and the web UI.
 *
 * Each topic holds sections, and each section owns the config namespaces (the
 * first segment of a key) it shows. A namespace no section lists belongs to
 * General's "Advanced" section, so no setting is ever unreachable. Pure data
 * with no runtime imports: the web UI imports it in the browser.
 */
import type { ConfigKey } from './schema-types.js';

export type SettingTopicId = 'general' | 'account' | 'models' | 'voice' | 'notifications' | 'memory' | 'permissions';

export interface SettingSection {
  /** Stable id; also the web UI's `?settings=<id>` link target. */
  readonly id: string;
  /** The section's name, shown beside a setting's key as `<label> · <key>`. */
  readonly label: string;
  /** One line under the section heading. */
  readonly description: string;
  /** Config namespaces shown in this section, in order. */
  readonly namespaces: readonly string[];
}

export interface SettingTopic {
  readonly id: SettingTopicId;
  readonly label: string;
  /** One line under the topic title. */
  readonly description: string;
  /** The topic's sections in the order they show; the first shares the topic's id. */
  readonly sections: readonly SettingSection[];
}

/** The section that holds every namespace no other section lists. */
export const UNCLAIMED_SETTINGS_SECTION = 'all';

export const SETTING_TOPICS: readonly SettingTopic[] = [
  {
    id: 'general',
    label: 'General',
    description: 'How GoodVibes looks and behaves, how devices reach it, and every other setting.',
    sections: [
      {
        id: 'general',
        label: 'Display',
        description: 'Appearance and how GoodVibes behaves.',
        namespaces: ['display', 'ui', 'behavior', 'daemon', 'update', 'diagnostics'],
      },
      {
        id: 'network',
        label: 'Network',
        description: 'How devices reach your daemon: Tailscale, Cloudflare, the relay and the listeners.',
        namespaces: ['network', 'relay', 'httpListener', 'controlPlane', 'web', 'cloudflare', 'service'],
      },
      {
        id: 'about',
        label: 'About',
        description: 'Your daemon, this browser\'s connection to it, and local sign-in.',
        namespaces: [],
      },
      {
        id: UNCLAIMED_SETTINGS_SECTION,
        label: 'Advanced',
        description: 'Supervised triggers and every other daemon setting.',
        namespaces: [],
      },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    description: 'How this browser signs in, your paired devices, and the people behind each channel.',
    sections: [
      {
        id: 'account',
        label: 'Sign-in',
        description: 'How this browser signs in to your daemon, and what it knows about you.',
        namespaces: ['profile', 'email', 'calendar', 'google'],
      },
      {
        id: 'devices',
        label: 'Devices and pairing',
        description: 'Paired devices, their tokens, and this computer\'s power.',
        namespaces: ['device', 'surfaces', 'fleet', 'cluster', 'power'],
      },
      {
        id: 'people',
        label: 'People and channels',
        description: 'Who a channel message belongs to, and each channel\'s defaults.',
        namespaces: [],
      },
    ],
  },
  {
    id: 'models',
    label: 'Models and providers',
    description: 'The model new chats use, the providers and credentials behind it, and what it costs.',
    sections: [
      {
        id: 'models',
        label: 'Model',
        description: 'The model new chats use, and the providers that serve it.',
        namespaces: ['provider', 'judgment', 'pricing', 'cache'],
      },
      {
        id: 'credentials',
        label: 'Credentials',
        description: 'What the daemon\'s credential store holds, and the accounts behind each provider.',
        namespaces: ['atRest'],
      },
      {
        id: 'usage',
        label: 'Usage',
        description: 'What each provider has used, budgets, and payments.',
        namespaces: ['payments', 'telemetry', 'batch'],
      },
    ],
  },
  {
    id: 'voice',
    label: 'Voice',
    description: 'Dictation, spoken replies and the wake word.',
    sections: [
      {
        id: 'voice',
        label: 'Voice',
        description: 'Dictation, spoken replies and the wake word.',
        namespaces: ['voice', 'tts'],
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Push notifications, install, occasion reminders and check-ins.',
    sections: [
      {
        id: 'notifications',
        label: 'Notifications',
        description: 'Push notifications, install and occasion reminders.',
        namespaces: ['notifications', 'push', 'occasions'],
      },
      {
        id: 'checkins',
        label: 'Check-ins',
        description: 'GoodVibes looks in on you on a schedule and tells you what is worth knowing.',
        namespaces: ['checkin'],
      },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'What GoodVibes remembers, how it tidies it up, and the daemon\'s memory use.',
    sections: [
      {
        id: 'memory',
        label: 'Memory',
        description: 'What GoodVibes remembers, how it tidies it up, and the daemon\'s memory use.',
        namespaces: ['memory', 'learning'],
      },
    ],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    description: 'Approval rules, the sandbox and tool policy.',
    sections: [
      {
        id: 'permissions',
        label: 'Permissions',
        description: 'Approval rules, MCP tool rules, the sandbox and tool policy.',
        namespaces: ['permissions', 'sandbox', 'policy', 'security', 'danger', 'tools', 'conversationGate', 'fetch'],
      },
    ],
  },
];

interface SectionPlace {
  readonly topic: SettingTopicId;
  readonly section: SettingSection;
}

const PLACE_BY_NAMESPACE = new Map<string, SectionPlace>();
let unclaimedPlace: SectionPlace | undefined;
for (const topic of SETTING_TOPICS) {
  for (const section of topic.sections) {
    if (section.id === UNCLAIMED_SETTINGS_SECTION) unclaimedPlace = { topic: topic.id, section };
    for (const namespace of section.namespaces) PLACE_BY_NAMESPACE.set(namespace, { topic: topic.id, section });
  }
}
const UNCLAIMED_PLACE: SectionPlace = unclaimedPlace ?? { topic: 'general', section: SETTING_TOPICS[0]!.sections[0]! };

/** The section that shows a namespace; namespaces no section lists go to General's "Advanced". */
export function sectionOfNamespace(namespace: string): SectionPlace {
  return PLACE_BY_NAMESPACE.get(namespace) ?? UNCLAIMED_PLACE;
}

/**
 * Where a setting is filed: its topic and the label of its section, the label a
 * settings row shows beside the key (`Display · display.showThinking`).
 */
export function topicOf(key: ConfigKey | string): { readonly topic: SettingTopicId; readonly section: string; readonly sectionId: string } {
  const namespace = key.split('.', 1)[0] ?? key;
  const place = sectionOfNamespace(namespace);
  return { topic: place.topic, section: place.section.label, sectionId: place.section.id };
}

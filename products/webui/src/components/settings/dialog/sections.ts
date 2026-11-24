/**
 * The settings dialog's pages and sections (design doc "Navigation map",
 * "Settings dialog sections"). Pure data and search logic, no React.
 *
 * The pages, their sections, their names, their one-line descriptions and the
 * config namespaces each section shows are the engine's one list of setting
 * topics (platform/config/setting-topics.ts SETTING_TOPICS), which the terminal
 * programs file every setting under too, so a setting is under the same topic
 * everywhere. This file adds only what the browser needs on top: the order a
 * page's sections render in (the topic's own order), the search words of each
 * section and the names of the hand-built settings it shows, and the old
 * section names a `?settings=` link may still carry.
 *
 * A page's namesake section (the one sharing its id, always first) renders
 * under the page title with no heading of its own; every further section
 * carries its own heading. A `?settings=<section>` link opens the section's
 * page and scrolls to it.
 *
 * Every config namespace belongs to exactly one section: the section that
 * lists it, else "Advanced", which also holds namespaces the daemon reports
 * that this build has never heard of. So a schema key is never unreachable.
 *
 * Search matches a section when every word of the query, in any order, is in
 * its name, its search words or the names of the hand-built settings it shows
 * (`items`), and separately counts the schema settings inside it whose name,
 * key and description hold every word (settings-model.ts's filterSettingsModel).
 */
import { SETTING_TOPICS, UNCLAIMED_SETTINGS_SECTION, type SettingTopicId } from '@goodvibes/engine/platform/platform/config/setting-topics';
import type { SettingsGroupModel } from '../../../lib/settings-model';
import { filterSettingsModel, matchesEveryWord, searchWords } from '../../../lib/settings-model';

export type SettingsSectionId =
  | 'general'
  | 'account'
  | 'devices'
  | 'people'
  | 'models'
  | 'decision-models'
  | 'credentials'
  | 'usage'
  | 'voice'
  | 'notifications'
  | 'memory'
  | 'permissions'
  | 'network'
  | 'all'
  | 'about'
  | 'checkins';

/** The seven pages the nav lists: the setting topics. Each page's id is also its first section's id. */
export type SettingsPageId = SettingTopicId;

export interface SettingsPageDef {
  id: SettingsPageId;
  label: string;
  /** One line under the page title. */
  description: string;
}

export const SETTINGS_PAGES: readonly SettingsPageDef[] = SETTING_TOPICS.map((topic) => ({
  id: topic.id,
  label: topic.label,
  description: topic.description,
}));

export interface SettingsSectionDef {
  id: SettingsSectionId;
  /** The section's heading inside its page, and its name in search. */
  label: string;
  /** The page that holds the section. */
  page: SettingsPageId;
  /** One line under the section heading. */
  description: string;
  /** Config namespaces rendered in this section, in order. */
  namespaces: readonly string[];
  /** Extra search words. */
  keywords: readonly string[];
  /** Names of the hand-built settings the section shows, searchable. */
  items: readonly string[];
}

/** What the browser adds to each section: its search words and the hand-built settings it shows. */
const SECTION_SEARCH: Readonly<Record<SettingsSectionId, { keywords: readonly string[]; items: readonly string[] }>> = {
  general: {
    keywords: ['appearance', 'theme', 'dark', 'light', 'neon', 'density', 'compact', 'timezone'],
    items: ['Theme', 'GoodVibes Neon', 'Density', 'Language', 'Line numbers in code blocks'],
  },
  account: {
    keywords: ['sign in', 'login', 'password', 'token', 'auth', 'passkey', 'step-up', 'profile', 'mail', 'calendar', 'admin'],
    items: ['Sign in', 'Sign-in code', 'Current sign-in', 'Step-up verification', 'Owner profile', 'Mail and calendar accounts'],
  },
  devices: {
    keywords: ['pair', 'pairing', 'phone', 'device', 'qr', 'revoke', 'keep awake', 'sleep', 'slack', 'discord', 'telegram'],
    items: ['Paired devices', 'Power', 'This browser as a phone node', 'Telegram delegated intake'],
  },
  people: {
    keywords: ['principals', 'identity', 'channel', 'binding', 'profiles'],
    items: ['Principals', 'Channel profiles'],
  },
  models: {
    keywords: ['model', 'provider', 'llm', 'ai', 'route', 'context', 'price', 'openai', 'anthropic', 'failover', 'fallback', 'backup', 'budget'],
    items: ['Current model', 'Providers', 'Models', 'Sign-in routes', 'Browse models'],
  },
  'decision-models': {
    keywords: ['judgment', 'decision', 'jev', 'policy', 'hybrid', 'deadline', 'fallback', 'backup', 'volume', 'advanced', 'decision model'],
    items: ['Decision models', 'Decision call-volume alerts'],
  },
  credentials: {
    keywords: ['secret', 'key', 'api key', 'subscription', 'accounts', 'store'],
    items: ['Credential status', 'Accounts and subscriptions'],
  },
  usage: {
    keywords: ['usage', 'cost', 'spend', 'budget', 'payment', 'card', 'tokens'],
    items: ['Provider usage'],
  },
  voice: {
    keywords: ['speech', 'microphone', 'mic', 'dictation', 'wake', 'stt', 'tts'],
    items: ['Voice input', 'Wake word'],
  },
  notifications: {
    keywords: ['push', 'install', 'alert', 'reminder'],
    items: ['Push notifications', 'Install'],
  },
  checkins: {
    keywords: ['check-in', 'checkin', 'proactive', 'schedule', 'quiet hours', 'cadence'],
    items: ['Check-in settings', 'Run check-in now', 'Recent receipts'],
  },
  memory: {
    keywords: ['provenance', 'consolidation', 'remember', 'recall', 'diagnostics'],
    items: ['Memory provenance chips', 'Memory diagnostics'],
  },
  permissions: {
    keywords: ['approval', 'approve', 'allow', 'deny', 'ask', 'stop asking', 'ask less', 'how often', 'mode', 'jev', 'yolo', 'sandbox', 'policy', 'safety', 'mcp', 'server'],
    items: ['When GoodVibes asks', 'Ask me', 'Jev decides', 'Just vibes', 'YOLO', 'Approval rules', 'MCP tool rules'],
  },
  network: {
    keywords: ['tailscale', 'cloudflare', 'tunnel', 'worker', 'https', 'serve', 'lan', 'relay', 'port', 'listener'],
    items: ['Tailscale', 'Cloudflare'],
  },
  all: {
    keywords: ['triggers', 'supervision', 'all settings', 'config', 'key', 'schema'],
    items: ['Supervised triggers'],
  },
  about: {
    keywords: ['version', 'status', 'daemon', 'origin', 'realtime', 'diagnostics'],
    items: ['Daemon status', 'Connection', 'Local sign-in'],
  },
};

function isSectionId(id: string): id is SettingsSectionId {
  return Object.hasOwn(SECTION_SEARCH, id);
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = SETTING_TOPICS.flatMap((topic) => topic.sections.flatMap((section): SettingsSectionDef[] => {
  // A section this build has no page code for is left out rather than drawn empty.
  if (!isSectionId(section.id)) return [];
  return [{
    id: section.id,
    label: section.label,
    page: topic.id,
    description: section.description,
    namespaces: section.namespaces,
    keywords: SECTION_SEARCH[section.id].keywords,
    items: SECTION_SEARCH[section.id].items,
  }];
}));

const SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]));
const PAGE_BY_ID = new Map(SETTINGS_PAGES.map((p) => [p.id, p]));

/** The order sections render in on their page: the topic's own order. */
const PAGE_SECTION_ORDER: ReadonlyMap<SettingsPageId, readonly SettingsSectionId[]> = new Map(
  SETTING_TOPICS.map((topic) => [topic.id, topic.sections.map((section) => section.id).filter(isSectionId)]),
);
const pageSectionOrder = (id: SettingsPageId): readonly SettingsSectionId[] => PAGE_SECTION_ORDER.get(id) ?? [];

export function settingsPage(id: SettingsPageId): SettingsPageDef {
  return PAGE_BY_ID.get(id) ?? SETTINGS_PAGES[0];
}

/** The page a section lives on. */
export function pageOfSection(id: SettingsSectionId): SettingsPageId {
  return settingsSection(id).page;
}

/** A page's sections, in the order they render. */
export function sectionsOfPage(id: SettingsPageId): SettingsSectionDef[] {
  return pageSectionOrder(id).map((sectionId) => settingsSection(sectionId));
}

/** Old or alternate section names that deep links may carry. */
const SECTION_ALIASES: Readonly<Record<string, SettingsSectionId>> = {
  admin: 'account',
  providers: 'models',
  principals: 'people',
  pairing: 'devices',
  advanced: 'all',
  checkin: 'checkins',
};

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general';

/** The section a `?settings=` value names; unknown values open General. */
export function resolveSettingsSection(raw: string | null | undefined): SettingsSectionId {
  const key = (raw ?? '').trim();
  if (SECTION_BY_ID.has(key as SettingsSectionId)) return key as SettingsSectionId;
  return SECTION_ALIASES[key] ?? DEFAULT_SETTINGS_SECTION;
}

export function settingsSection(id: SettingsSectionId): SettingsSectionDef {
  return SECTION_BY_ID.get(id) ?? SETTINGS_SECTIONS[0];
}

const NAMESPACE_OWNER = new Map<string, SettingsSectionId>();
for (const section of SETTINGS_SECTIONS) {
  for (const ns of section.namespaces) NAMESPACE_OWNER.set(ns, section.id);
}

/** The section that renders a config namespace ("All settings" for the rest). */
export function sectionForNamespace(namespace: string): SettingsSectionId {
  return NAMESPACE_OWNER.get(namespace) ?? 'all';
}

/** The config groups a section renders, in its declared order ("All settings": everything unclaimed). */
export function groupsForSection(id: SettingsSectionId, groups: readonly SettingsGroupModel[]): SettingsGroupModel[] {
  if (id === UNCLAIMED_SETTINGS_SECTION) return groups.filter((g) => !NAMESPACE_OWNER.has(g.id));
  const order = settingsSection(id).namespaces;
  return order
    .map((ns) => groups.find((g) => g.id === ns))
    .filter((g): g is SettingsGroupModel => Boolean(g));
}

export interface SectionMatch {
  id: SettingsSectionId;
  /** The label, a keyword or a hand-built setting matched: show the whole section. */
  whole: boolean;
  /** How many schema settings in the section match the query. */
  settingCount: number;
}

function countSettings(groups: readonly SettingsGroupModel[]): number {
  return groups.reduce(
    (n, g) => n + g.plainRows.length + g.rawRows.length
      + g.featureUnits.reduce((m, u) => m + Math.max(1, u.fields.length), 0),
    0,
  );
}

/**
 * Sections that match a search query, in nav order. With an empty query every
 * section matches whole. `groups` is the full config model (possibly empty
 * while config is loading or refused, then only labels and words match).
 */
export function matchSettingsSections(query: string, groups: readonly SettingsGroupModel[]): SectionMatch[] {
  const words = searchWords(query);
  if (words.length === 0) return SETTINGS_SECTIONS.map((s) => ({ id: s.id, whole: true, settingCount: 0 }));
  const out: SectionMatch[] = [];
  for (const section of SETTINGS_SECTIONS) {
    // Every word of the query, in any order, among the section's name, search words and settings.
    const whole = matchesEveryWord([section.label, ...section.keywords, ...section.items], words);
    const filtered = filterSettingsModel(groupsForSection(section.id, groups), query);
    const settingCount = countSettings(filtered);
    if (whole || settingCount > 0) out.push({ id: section.id, whole, settingCount });
  }
  return out;
}

export interface PageMatch {
  id: SettingsPageId;
  /** The page's sections that match, in render order. */
  sections: SectionMatch[];
  /** Matching schema settings across the page. */
  settingCount: number;
}

/** Pages with at least one matching section, in nav order, from section matches. */
export function matchSettingsPages(matches: readonly SectionMatch[]): PageMatch[] {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const out: PageMatch[] = [];
  for (const page of SETTINGS_PAGES) {
    const sections = pageSectionOrder(page.id)
      .map((id) => byId.get(id))
      .filter((m): m is SectionMatch => Boolean(m));
    if (sections.length === 0) continue;
    out.push({ id: page.id, sections, settingCount: sections.reduce((n, m) => n + m.settingCount, 0) });
  }
  return out;
}

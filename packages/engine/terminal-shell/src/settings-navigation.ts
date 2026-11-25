import { SETTING_TOPICS, UNCLAIMED_SETTINGS_SECTION, sectionOfNamespace, type SettingTopicId } from '@goodvibes/engine/platform/platform/config/setting-topics';

interface SettingsSelectionState {
  editingMode: boolean;
  contextScroll: number;
  searchFocused: boolean;
  selectedIndex: number;
  readonly searchResults: readonly unknown[];
  readonly currentCategory: string;
  subscriptionLogoutConfirmationTarget: string | null;
}
export function moveSettingsSelection(
  state: SettingsSelectionState,
  direction: -1 | 1,
  policy: {
    readonly items: () => number;
    readonly specialItems: () => number;
    readonly clearSearchConfirmation: boolean;
  },
): void {
  if (state.editingMode) return;
  state.contextScroll = 0;
  if (state.searchFocused) {
    const count = state.searchResults.length;
    if (count > 0) {
      state.selectedIndex = (state.selectedIndex + direction + count) % count;
      if (policy.clearSearchConfirmation) state.subscriptionLogoutConfirmationTarget = null;
    }
    return;
  }
  const count = policy.items();
  if (count > 0) {
    state.selectedIndex = (state.selectedIndex + direction + count) % count;
    state.subscriptionLogoutConfirmationTarget = null;
    return;
  }
  const special = policy.specialItems();
  if (special > 0) {
    state.selectedIndex = (state.selectedIndex + direction + special) % special;
    if (state.currentCategory === 'subscriptions') state.subscriptionLogoutConfirmationTarget = null;
  }
}
/** Where a settings target landed. `not-found`: no topic or setting has that name, so the text became the search. */
export type SettingsTargetOutcome = 'category' | 'setting' | 'not-found' | 'none';

/** What `/settings open <target>` prints when the target named no topic or setting. */
export function settingsTargetNotFoundMessage(target: string): string {
  return `No topic or setting is named "${target}"; settings is showing a search for it.`;
}

export function selectedSettingsCategoryEntry<Entry>(
  category: string,
  expected: string,
  entries: readonly Entry[],
  index: number,
): Entry | null {
  if (category !== expected || entries.length === 0) return null;
  return entries[Math.max(0, Math.min(entries.length - 1, index))] ?? null;
}

// ---------------------------------------------------------------------------
// Topics: the seven the web UI shows, each listing its sections' settings
// ---------------------------------------------------------------------------

/** Where a setting is filed: a topic and a section. */
export interface SettingPlace {
  readonly topic: SettingTopicId;
  readonly sectionId: string;
  /** The section's name; `/settings <section>` lands on its first row. */
  readonly section: string;
}

/**
 * Where a setting is filed: its key's own section, as the web UI files it. A
 * key no section claims (a program's own setting) is filed with the group
 * the program lists it in, so a terminal-only row sits beside its neighbours.
 */
export function settingPlace(key: string, listedUnder: string): SettingPlace {
  const own = sectionOfNamespace(key.split('.', 1)[0] ?? key);
  const place = own.section.id === UNCLAIMED_SETTINGS_SECTION ? sectionOfNamespace(listedUnder) : own;
  return { topic: place.topic, sectionId: place.section.id, section: place.section.label };
}

/** A list a topic opens in place of a setting: MCP servers, provider sign-ins, features, connections. */
export interface SettingsTopicList<Category extends string> {
  readonly category: Category;
  /** Its name in a topic's rows. */
  readonly label: string;
  /** What it is, in a sentence: the help under the rows when it is selected. */
  readonly description: string;
  readonly topic: SettingTopicId;
  /** The section id it is filed under. */
  readonly sectionId: string;
}

export type SettingsTopicRow<Entry, Category extends string> =
  | { readonly kind: 'setting'; readonly entry: Entry; readonly place: SettingPlace }
  | { readonly kind: 'list'; readonly list: SettingsTopicList<Category>; readonly place: SettingPlace };

export interface SettingsTopicView<Entry, Category extends string> {
  readonly id: SettingTopicId;
  readonly label: string;
  readonly description: string;
  /** Every setting and list in this topic, section by section; a setting listed twice appears once. */
  readonly rows: readonly SettingsTopicRow<Entry, Category>[];
}

/**
 * Build the seven topics' rows once from a program's groups (category to
 * entries, in the program's order) and the lists it opens. Rows within a
 * section follow the section's own namespace order, then the program's order.
 */
export function buildSettingsTopics<Category extends string, Entry extends { readonly setting: { readonly key: string } }>(
  groups: ReadonlyMap<Category, readonly Entry[]>,
  lists: readonly SettingsTopicList<Category>[],
): SettingsTopicView<Entry, Category>[] {
  const bySection = new Map<string, { readonly rank: number; readonly row: SettingsTopicRow<Entry, Category> }[]>();
  const sectionOf = new Map<string, readonly string[]>();
  for (const topic of SETTING_TOPICS) for (const section of topic.sections) sectionOf.set(`${topic.id}/${section.id}`, section.namespaces);
  const seen = new Set<string>();
  let order = 0;
  const add = (place: SettingPlace, namespace: string, row: SettingsTopicRow<Entry, Category>): void => {
    const id = `${place.topic}/${place.sectionId}`;
    const namespaces = sectionOf.get(id) ?? [];
    const index = namespaces.indexOf(namespace);
    const rank = (index < 0 ? namespaces.length : index) * 100_000 + order++;
    const rows = bySection.get(id);
    if (rows) rows.push({ rank, row });
    else bySection.set(id, [{ rank, row }]);
  };
  for (const [category, entries] of groups) {
    for (const entry of entries) {
      const key = entry.setting.key;
      if (seen.has(key)) continue;
      seen.add(key);
      const place = settingPlace(key, category);
      const own = key.split('.', 1)[0] ?? key;
      add(place, sectionOfNamespace(own).section.id === UNCLAIMED_SETTINGS_SECTION ? category : own, { kind: 'setting', entry, place });
      // A section that also shows this setting (setting-topics.ts alsoShows) lists it after its own rows.
      for (const topic of SETTING_TOPICS) {
        for (const section of topic.sections) {
          if (!section.alsoShows?.includes(key)) continue;
          const also: SettingPlace = { topic: topic.id, sectionId: section.id, section: section.label };
          add(also, '\u0000also', { kind: 'setting', entry, place: also });
        }
      }
    }
  }
  for (const list of lists) {
    const section = SETTING_TOPICS.find((topic) => topic.id === list.topic)?.sections.find((candidate) => candidate.id === list.sectionId);
    if (!section) continue;
    const place: SettingPlace = { topic: list.topic, sectionId: section.id, section: section.label };
    add(place, '\u0000list', { kind: 'list', list, place });
  }
  return SETTING_TOPICS.map((topic) => ({
    id: topic.id,
    label: topic.label,
    description: topic.description,
    rows: topic.sections.flatMap((section) =>
      (bySection.get(`${topic.id}/${section.id}`) ?? []).sort((a, b) => a.rank - b.rank).map((item) => item.row),
    ),
  }));
}

/** Every setting entry of the topics, once each, in browse order: what search filters. */
export function settingsTopicEntries<Entry, Category extends string>(topics: readonly SettingsTopicView<Entry, Category>[]): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<Entry>();
  // A setting a second section also shows is searched once.
  for (const topic of topics) for (const row of topic.rows) if (row.kind === 'setting' && !seen.has(row.entry)) { seen.add(row.entry); entries.push(row.entry); }
  return entries;
}

// ---------------------------------------------------------------------------
// Secure address: what the daemon serves now, the list both terminal programs open
// ---------------------------------------------------------------------------

/** One line of the "Secure address now" list: a name, a short state, and the daemon's own words under it. */
export interface SecureAddressRow {
  readonly label: string;
  readonly state: string;
  readonly detail: readonly string[];
  /**
   * Enter on this row: `reissue` "Issue a new certificate now" (secureAddress.reissue); `serve` "Serve other machines"
   * (secureAddress.serve); `replace-authority` asks first, its two answers in its place opening on No:
   * `keep-authority` (No) and `confirm-replace-authority` (secureAddress.replaceAuthority).
   */
  readonly action?: 'reissue' | 'serve' | 'replace-authority' | 'keep-authority' | 'confirm-replace-authority' | undefined;
  /** What Enter does here, for the key hints ("issue a new certificate"). */
  readonly hint?: string | undefined;
  /** The question an act that cannot be undone is asked with first (the daemon's words). */
  readonly question?: string | undefined;
  /** The outcome of the last act pressed here: kept when the rows are read again (a rebind or the daemon back). */
  readonly outcome?: true | undefined;
}

/** The rows read again, with the outcome of the last act still said (second, after "In force now") when it is not there. */
export function keepSecureAddressOutcome(before: readonly SecureAddressRow[], rows: readonly SecureAddressRow[]): SecureAddressRow[] {
  const outcome = before.find((row) => row.outcome === true);
  if (!outcome || rows.length === 0 || rows.some((row) => row.outcome === true)) return [...rows];
  const at = rows.findIndex((row) => row.label === outcome.label);
  if (at >= 0) return rows.map((row, index) => index === at ? { ...outcome, ...(row.action ? { action: row.action, hint: row.hint, question: row.question } : { action: undefined, hint: undefined }) } : row);
  return [rows[0]!, { ...outcome, action: undefined, hint: undefined }, ...rows.slice(1)];
}

/** The method each acting row runs; `replace-authority` and `keep-authority` run none. */
const ROW_METHODS: Readonly<Partial<Record<NonNullable<SecureAddressRow['action']>, string>>> = {
  reissue: 'secureAddress.reissue', serve: 'secureAddress.serve', 'confirm-replace-authority': 'secureAddress.replaceAuthority',
};

/** A date and time in the local form, month in words: when a certificate was received. */
function atTime(ms: unknown): string {
  return typeof ms === 'number' && ms > 0 ? `${untilDay(ms)} at ${new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` : '';
}

/** The rows before the daemon answers: stated as asking, never as a guess. */
export const SECURE_ADDRESS_CHECKING_ROWS: readonly SecureAddressRow[] = [
  { label: 'In force now', state: 'checking', detail: ['Asking the daemon what its https address serves…'] },
];

/** A certificate's end date in the one form every Secure address screen uses (the local date, month in words: the daemon's secureAddressDate). */
function untilDay(ms: unknown): string {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
}

/**
 * The rows of the daemon's `secureAddress.get` answer: what is in force, the
 * group's line, each way's state in the daemon's words, and how to change it
 * here. No key or token is in the answer, so none can be shown.
 */
/** The parts of a `secureAddress.get` answer the list reads (the method's output schema; every part optional here). */
interface SecureAddressAnswer {
  /** A notice no owner channel carried; shown first (the daemon marks it given once it is in an answer). */
  readonly notice?: string;
  readonly intro?: string;
  readonly node?: boolean;
  readonly groupLines?: readonly string[];
  readonly choices?: readonly { readonly id: string; readonly title: string; readonly does: string; readonly needs: string; readonly phoneGains: string; readonly sends: string; readonly caution?: string }[];
  readonly inForce?: { readonly on?: boolean; readonly certificate?: string; readonly serving?: boolean; readonly address?: string; readonly notAfter?: number; readonly problem?: string; readonly reach?: string };
  readonly letsEncrypt?: { readonly tokenStored?: boolean; readonly tokenUnreadable?: string; readonly lastAttempt?: { readonly words: string }; readonly addressProblem?: string; readonly routerCheck?: { readonly words: string } };
  readonly ownFiles?: { readonly check?: { readonly ok: boolean; readonly problem?: string; readonly names?: readonly string[]; readonly notAfter?: number } };
  readonly localAuthority?: { readonly page?: string; readonly fingerprint?: string };
  readonly tailscale?: { readonly address?: string };
  readonly group?: {
    readonly received?: { readonly leadName: string; readonly names?: readonly string[]; readonly notAfter?: number; readonly receivedAt?: number };
    readonly followers?: readonly { readonly name: string; readonly address: string; readonly port?: number; readonly covered: boolean; readonly needs?: string }[];
  };
  readonly reissue?: { readonly title: string; readonly line: string; readonly available: boolean };
  readonly replaceAuthority?: { readonly title: string; readonly line: string; readonly question?: string; readonly available: boolean };
  readonly serve?: { readonly title: string; readonly line: string; readonly available: boolean };
}

export function secureAddressRows(answer: unknown): SecureAddressRow[] {
  const a = (answer ?? {}) as SecureAddressAnswer;
  const force = a.inForce ?? {};
  const rows: SecureAddressRow[] = [];
  if (a.notice) rows.push({ label: 'Notice', state: 'new', detail: [a.notice] });
  // The intro asks the person to pick one way: a node picks none (its address comes from its lead), so it is not said there.
  const intro = a.intro && a.node !== true ? [a.intro] : [];
  // Served on https, but other machines are not answered: phones cannot open it yet (said, with the control that serves them).
  const reach = force.reach ? [force.reach] : [];
  rows.push(force.serving
    ? { label: 'In force now', state: reach.length > 0 ? 'phones cannot reach it' : 'https on', detail: [reach.length > 0 ? `This computer serves ${force.address ?? 'the https address'}${force.notAfter ? `, certificate valid until ${untilDay(force.notAfter)}` : ''}.` : `Phones open ${force.address ?? 'the https address'}${force.notAfter ? `, certificate valid until ${untilDay(force.notAfter)}` : ''}.${intro.length > 0 ? '' : ' The plain http address keeps working.'}`, ...reach, ...intro] }
    : force.on
      ? { label: 'In force now', state: 'not served', detail: [`https is switched on but not served: ${force.problem ?? 'no reason given'}`, ...reach, ...intro] }
      : { label: 'In force now', state: 'https off', detail: ['Phones use the plain http address, with chat and little else.', ...intro] });
  if (a.serve?.available && force.on) rows.push({ label: a.serve.title, state: 'Enter serves them', detail: [a.serve.line, ...reach], action: 'serve', hint: 'serve other machines' });
  const groupLines = a.groupLines ?? [];
  const group = a.group ?? {};
  if (a.node === true) {
    const received = group.received;
    rows.push({ label: 'From the lead of your group', state: received ? 'received' : 'waiting', detail: [
      ...groupLines,
      // When it came: a new certificate is told from the old one on screen.
      received ? `Received from ${received.leadName}${received.receivedAt ? ` on ${atTime(received.receivedAt)}` : ''}: a certificate for ${(received.names ?? []).join(', ')}, valid until ${untilDay(received.notAfter)}; renewed there and sent here by itself.` : 'Nothing received yet.',
      'Nothing is set on this machine.',
    ] });
    return rows;
  }
  const followers = group.followers ?? [];
  if (groupLines.length > 0 || followers.length > 0) {
    rows.push({ label: 'Your group', state: `${followers.length} following`, detail: [
      ...groupLines,
      ...followers.map((follower) => `${follower.name}: ${follower.covered ? `opened at https://${follower.address}${follower.port !== undefined ? `:${follower.port}` : ''}` : follower.needs ?? 'not covered by the certificate here'}`),
    ] });
  }
  if (a.reissue?.available) rows.push({ label: a.reissue.title, state: 'Enter issues it', detail: [a.reissue.line], action: 'reissue', hint: 'issue a new certificate' });
  if (a.replaceAuthority?.available) {
    rows.push({ label: a.replaceAuthority.title, state: 'Enter asks first', detail: [a.replaceAuthority.line], action: 'replace-authority', hint: 'replace the authority', ...(a.replaceAuthority.question ? { question: a.replaceAuthority.question } : {}) });
  }
  const choices = new Map((a.choices ?? []).map((choice) => [choice.id, choice]));
  const explain = (id: string): string[] => {
    const words = choices.get(id);
    return words ? [`What it does: ${words.does}`, `What it needs from you: ${words.needs}`, `What the phone gains: ${words.phoneGains}`, `What is sent where: ${words.sends}`, ...(words.caution ? [`Before you choose it: ${words.caution}`] : [])] : [];
  };
  const inUse = (id: string): boolean => force.on === true && force.certificate === id;
  const le = a.letsEncrypt ?? {};
  rows.push({ label: choices.get('lets-encrypt')?.title ?? 'Let\'s Encrypt', state: inUse('lets-encrypt') ? 'in use' : 'not in use', detail: [
    ...(le.lastAttempt ? [le.lastAttempt.words] : []),
    ...(le.addressProblem ? [le.addressProblem] : []),
    ...(le.routerCheck ? [le.routerCheck.words] : []),
    le.tokenStored ? 'Token: stored.' : le.tokenUnreadable ? `Token: ${le.tokenUnreadable}` : 'Token: none stored yet.',
    ...explain('lets-encrypt'),
  ] });
  const check = a.ownFiles?.check;
  rows.push({ label: choices.get('own-files')?.title ?? 'A certificate you made', state: inUse('own-files') ? 'in use' : 'not in use', detail: [
    ...(check ? [check.ok ? `Covers ${(check.names ?? []).join(', ')}; valid until ${untilDay(check.notAfter)}.` : check.problem ?? ''] : []),
    ...explain('own-files'),
  ] });
  const tailscale = a.tailscale ?? {};
  rows.push({ label: choices.get('tailscale')?.title ?? 'Tailscale', state: tailscale.address ? 'served' : 'not served', detail: [
    ...(tailscale.address ? [`Served at ${tailscale.address}.`] : ['Served from the web app: Settings, General, Secure address (or Network, Tailscale), once Tailscale is installed and signed in here.']),
    ...explain('tailscale'),
  ] });
  const local = a.localAuthority ?? {};
  rows.push({ label: choices.get('local-authority')?.title ?? 'GoodVibes\' own certificate', state: inUse('local-authority') ? 'in use' : 'not in use', detail: [
    ...(local.page ? [`On each phone, once: open ${local.page}${local.fingerprint ? ` (fingerprint ${local.fingerprint})` : ''}.`] : []),
    ...explain('local-authority'),
  ] });
  rows.push({ label: 'How to change it here', state: '', detail: [
    'Pick "Certificate the https address uses" in this section and fill in its fields (the name, or the two file paths); "Serve the web UI over https on your network" switches it on or off; the Cloudflare API token row stores the token. The daemon checks them and starts at once.',
    'The web app shows the same screen with a form for each way: Settings, General, Secure address.',
  ] });
  return rows;
}

/**
 * Enter on an action row: run its daemon method (secureAddress.reissue) and
 * build the rows from the answer, the action row carrying the daemon's line
 * about what happened. A row with no action, or no connection, changes
 * nothing. Never throws.
 */
export async function runSecureAddressRowAction(
  invoke: ((method: string, input: Record<string, unknown>) => Promise<unknown>) | null,
  row: SecureAddressRow | undefined,
  /** The rows shown now: "Replace the authority" puts its question in its own place, opening on No. */
  shown: readonly SecureAddressRow[] = [],
): Promise<SecureAddressRow[] | null> {
  if (!row?.action || !invoke) return null;
  // Asked first: the row becomes the question's two answers, No where the cursor is (it stays on this index).
  if (row.action === 'replace-authority') {
    const at = shown.indexOf(row);
    const question = row.question ?? 'Replace the authority?';
    const answers: SecureAddressRow[] = [
      { label: 'No, keep the authority', state: 'Enter keeps it', detail: [question, ...row.detail], action: 'keep-authority', hint: 'keep it' },
      { label: 'Yes, replace the authority', state: 'Enter replaces it', detail: [question, ...row.detail], action: 'confirm-replace-authority', hint: 'replace it' },
    ];
    return at >= 0 ? [...shown.slice(0, at), ...answers, ...shown.slice(at + 1)] : [...shown, ...answers];
  }
  if (row.action === 'keep-authority') {
    // No: nothing changes, and the row says so in one line (kept when the rows are read again).
    const rows = await readSecureAddressRows(invoke);
    const at = rows.findIndex((candidate) => candidate.action === 'replace-authority');
    const kept: SecureAddressRow = {
      label: 'Replace the authority', state: 'kept', outcome: true,
      detail: ['The authority was kept: nothing changed here or on any phone.', ...(at >= 0 ? rows[at]!.detail : [])],
      ...(at >= 0 ? { action: rows[at]!.action, hint: rows[at]!.hint, question: rows[at]!.question } : {}),
    };
    if (at >= 0) rows[at] = kept; else rows.splice(1, 0, kept);
    return rows;
  }
  const method = ROW_METHODS[row.action];
  if (!method) return null;
  const doneWord = row.action === 'serve' ? ['served', 'not served'] : row.action === 'reissue' ? ['issued', 'not issued'] : ['replaced', 'not replaced'];
  try {
    const answer = (await invoke(method, {})) as { readonly ok?: boolean; readonly words?: string; readonly status?: unknown } | null;
    const rows = secureAddressRows(answer?.status);
    const words = answer?.words ?? 'The daemon gave no answer.';
    const same = row.action === 'confirm-replace-authority' ? 'replace-authority' : row.action;
    const at = rows.findIndex((candidate) => candidate.action === same);
    const label = row.action === 'confirm-replace-authority' ? 'Replace the authority' : row.label;
    const done: SecureAddressRow = { label, state: answer?.ok ? doneWord[0]! : doneWord[1]!, detail: [words, ...(at >= 0 ? rows[at]!.detail : [])], outcome: true, ...(at >= 0 ? { action: rows[at]!.action, hint: rows[at]!.hint } : {}) };
    if (at >= 0) rows[at] = done; else rows.splice(1, 0, done);
    return rows;
  } catch (error) {
    // Serving other machines moves the daemon's listener, which can cut its own answer off: what it serves is read again.
    if (row.action === 'serve') {
      const rows = await readSecureAddressRows(invoke);
      if (rows[0]?.state !== 'phones cannot reach it' && rows[0]?.state !== 'unknown') {
        return keepSecureAddressOutcome([{ label: row.label, state: doneWord[0]!, outcome: true,
          detail: ['This daemon now answers your other machines and phones on the network: phones can open the https address. Its listener moved to do so, so its answer was read again here.'] }], rows);
      }
    }
    return [{ label: row.label, state: doneWord[1]!, outcome: true, detail: [`The daemon refused: ${error instanceof Error ? error.message : String(error)}`] }];
  }
}

/** Ask the daemon (through the in-process gateway catalog, forwarded to the daemon) and build the rows. Never throws. */
export async function readSecureAddressRows(invoke: ((method: string, input: Record<string, unknown>) => Promise<unknown>) | null): Promise<SecureAddressRow[]> {
  if (!invoke) return [{ label: 'In force now', state: 'unknown', detail: ['This session has no connection to the daemon\'s methods, so what it serves cannot be read here.'] }];
  try {
    return secureAddressRows(await invoke('secureAddress.get', {}));
  } catch (error) {
    return [{ label: 'In force now', state: 'unknown', detail: [`The daemon did not answer: ${error instanceof Error ? error.message : String(error)}`] }];
  }
}

/** Where `/settings open <target>` lands: a topic, a section's first row, a list, or a setting by key or name. */
export type SettingsTopicTarget<Category extends string> =
  | { readonly kind: 'topic'; readonly topicIndex: number; readonly rowIndex: number }
  | { readonly kind: 'list'; readonly topicIndex: number; readonly rowIndex: number; readonly category: Category }
  | { readonly kind: 'setting'; readonly topicIndex: number; readonly rowIndex: number };

export function findSettingsTopicTarget<Entry extends { readonly setting: { readonly key: string } }, Category extends string>(
  topics: readonly SettingsTopicView<Entry, Category>[],
  target: string,
  label: (entry: Entry) => string,
): SettingsTopicTarget<Category> | null {
  const wanted = target.trim().toLowerCase();
  if (!wanted) return null;
  const topicIndex = topics.findIndex((topic) => topic.id === wanted || topic.label.toLowerCase() === wanted);
  if (topicIndex >= 0) return { kind: 'topic', topicIndex, rowIndex: 0 };
  for (const [index, topic] of topics.entries()) {
    for (const [rowIndex, row] of topic.rows.entries()) {
      if (row.kind === 'list' && (row.list.category.toLowerCase() === wanted || row.list.label.toLowerCase() === wanted))
        return { kind: 'list', topicIndex: index, rowIndex, category: row.list.category };
      if (row.kind === 'setting' && (row.entry.setting.key.toLowerCase() === wanted || label(row.entry).toLowerCase() === wanted))
        return { kind: 'setting', topicIndex: index, rowIndex };
    }
  }
  // A section's name or id, or a namespace ("network", "sandbox"): the first row filed there.
  for (const [index, topic] of topics.entries()) {
    const rowIndex = topic.rows.findIndex(
      (row) =>
        row.place.section.toLowerCase() === wanted ||
        row.place.sectionId === wanted ||
        (row.kind === 'setting' && (row.entry.setting.key.split('.', 1)[0] ?? '').toLowerCase() === wanted),
    );
    if (rowIndex >= 0) return { kind: 'topic', topicIndex: index, rowIndex };
  }
  return null;
}

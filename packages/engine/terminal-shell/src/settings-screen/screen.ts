/**
 * settings-screen/screen.ts, the one settings screen of both terminal programs.
 *
 * Opened by `/settings`, from the System place and from the menu; drawn with
 * the surface kit on the program's modal stack. The seven topics the web UI
 * shows, each listing its sections' settings one line each; typing filters
 * every setting by name, key or what it does. Under the rows, the selected one
 * explained in the space the rows leave.
 *
 * Every value is the daemon's answer (`settings.list`) and every change goes
 * through the settings capabilities (`settings.set`, `settings.reset`), so the
 * change made here is the one the model, an outside agent, a script and the
 * web UI make. A setting the daemon owns is one value, the same from either
 * program; a setting a program keeps is shown under that program's name, and
 * the other program's are a key away (the `program` input). The values are read
 * when the screen opens, again on the daemon's settings events (a change made
 * in the browser shows with no key pressed) and when the daemon is back; one
 * that could not be read says why.
 *
 * A value is typed in a plain field (hidden for a password or key); a choice is
 * a list; a change that loosens a protection asks first, opening on No; any
 * other applies at once, and the line under the rows says what it became and
 * how to put it back. Every key is an entry of the program's key table
 * (keys.ts) or one of its navigation actions; the leader works over it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { DaemonFrameStreamState } from '@goodvibes/engine/platform/platform/runtime/client';
import { configKeyFacts, isDaemonOwnedConfigKey, isSecretConfigKey, type ConfigKey, type ConfigManager, type ConfigSetting } from '@goodvibes/engine/platform/platform/config';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes/engine/platform/platform/payments';
import { gatePresetLabel, isGatePresetName } from '@goodvibes/engine/platform/platform/gate/presets';
import { DAEMON_RESTART_SETTINGS } from '@goodvibes/engine/platform/platform/runtime/program-host-settings';
import { REASONING_EFFORT_SEVERITY } from '@goodvibes/engine/contracts';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import { MCP_TRUST_LEVEL_WORDS, mcpTrustWords } from '@goodvibes/engine/platform/platform/mcp/trust-words';
import type { SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import type { ServiceInspectionQuery } from '@goodvibes/engine/platform/platform/runtime/ui';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from '../surface-modal-host.js';
import { keyTokenFromText, type KeyToken } from '../keybindings.js';
import type { SurfaceLayer, KitHint } from '../renderer/surface-kit.js';
import type { KitRow } from '../renderer/surface-kit-list.js';
import { createSettingsLayout, settingsTopicRailRows } from '../renderer/settings-layout.js';
import { createSettingsRows } from '../renderer/settings-rows.js';
import { createSettingsDocumentation, fitValue, helpFact, helpHeading, helpText, type HelpLine } from '../renderer/settings-documentation.js';
import { asSentence } from '../renderer/settings-context.js';
import { flagStateColor, settingChoiceWords } from '../renderer/settings-value-helpers.js';
import { activeTokens } from '../renderer/theme.js';
import {
  buildSettingsTopics, findSettingsTopicTarget, keepSecureAddressOutcome, readSecureAddressRows, runSecureAddressRowAction, SECURE_ADDRESS_CHECKING_ROWS, settingsTopicEntries,
  type SecureAddressRow, type SettingsTargetOutcome, type SettingsTopicList, type SettingsTopicRow, type SettingsTopicView,
} from '../settings-navigation.js';
import { searchSettingsInOrder } from '../settings-search.js';
import { adjustedSettingValue, cycleSettingChoice, modelPickerLaunchForKey, parseNumberEditBuffer } from '../settings-behavior.js';
import { SETTINGS_CHOICE_ACTIONS, openSettingsChoice, type SettingsChoiceAction, type SettingsChoiceContext } from '../settings-choice-actions.js';
import { openDecisionRouterSettings, type DecisionRouterPickerContext } from '../decision-router-settings-actions.js';
import { buildMcpEntries } from '../settings-mcp-entries.js';
import { openPaymentsCardsFromSettings } from '../payments-settings.js';
import { buildSubscriptionEntries, type SubscriptionEntry } from '../settings-subscriptions.js';
import { featureEnablementWrite, isFeatureValueEnabled } from '../cli-feature-settings.js';
import type { McpEntry } from '../settings-model-types.js';
import type { ActionValues, CommandActionContext } from '../command-actions/types.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from '../command-actions/capability-actions.js';
import type { SelectionItem } from '../selection-modal.js';
import { keycapOf, reasonOf, type PlaceHost } from '../places/place-host.js';
import {
  applyValue, buildScreenGroups, featureListOf, listEditText, listedValuesOf, parseListEdit, programDefaultOf,
  type FlagStates, type ScreenEntry, type ScreenFlag, type ScreenProgram, type ValueState,
} from './rows.js';
import {
  connectionHelp, connectionLabel, currentSettingValue, enumDescriptionsFor, flagHelp, formatDefault, formatValue, getSettingLabel, mcpHelp,
  programName, settingHelp, subscriptionHelp, valueColor, type ConnectionRow, type HelpState,
} from './help.js';
import { SETTINGS_KEY_CONTEXT_ID, SETTINGS_KEYS } from './keys.js';

/** What a program gives the settings screen: what it keeps itself, and how it draws the pickers it owns. */
export interface SettingsScreenProgram {
  /** This program's name. */
  readonly program: ScreenProgram;
  /** This program's settings: where the daemon keeps its own, and what the pickers it owns read. */
  readonly configManager: Pick<ConfigManager, 'get' | 'getDaemonTierPath' | 'getWorkingDirectory'> & { getCustomProvidersDir?(): string };
  /** This program's feature gate: which features it registers and whether each is on now. */
  readonly featureFlags?: { getAll(): ReadonlyMap<string, { readonly state: string; readonly pendingRestart: boolean }> } | null | undefined;
  /** This program's tool server connections. */
  readonly mcpRegistry?: Pick<McpRegistry, 'listServerSecurity'> | null | undefined;
  /** Provider sign-ins, as this program reads them. */
  readonly subscriptions?: { readonly manager: SubscriptionManager; readonly services: Pick<ServiceInspectionQuery, 'getAll'> } | null | undefined;
  /** The models this program can use, for the rows that name a model or a provider. */
  readonly models?: (() => readonly { readonly id: string; readonly provider: string; readonly displayName?: string | undefined }[]) | undefined;
  /** The pickers this program draws (the theme with its live preview, the voices it can speak with). */
  readonly pickers: {
    readonly theme: (context: CommandActionContext) => boolean;
    readonly ttsProvider: (context: CommandActionContext) => boolean;
    readonly ttsVoice: (context: CommandActionContext) => Promise<unknown> | unknown;
  };
  /** The permission mode of the hosted session this program runs, when it runs one (the Agent); undefined otherwise. */
  readonly sessionMode?: (() => string | undefined) | undefined;
  /** What this program does itself after one of its settings changed (a theme applied, the service installed); a sentence it says. */
  readonly afterChange?: ((change: { readonly key: string; readonly previousValue: unknown; readonly value: unknown }) => { readonly message?: string | undefined } | void) | undefined;
}

export interface SettingsScreenOptions {
  readonly host: PlaceHost;
  readonly context: CommandActionContext;
  readonly binding: DaemonCapabilityBinding<never>;
  readonly program: SettingsScreenProgram;
  /** Take the screen off the modal stack. */
  readonly close: (screen: SettingsScreen) => void;
  /** Told once when the screen has left the modal stack. */
  readonly closed?: (() => void) | undefined;
}

/** The lists a topic opens in place of a setting. */
export type ScreenList = 'mcp' | 'subscriptions' | 'connections' | 'flags' | 'secure-address-now';

const TOPIC_LISTS: readonly SettingsTopicList<ScreenList>[] = [
  { category: 'mcp', label: 'Tool servers (MCP)', description: 'what each connected tool server may do', topic: 'permissions', sectionId: 'permissions' },
  { category: 'subscriptions', label: 'Provider sign-ins', description: 'subscriptions you signed in to, and signing out', topic: 'models', sectionId: 'credentials' },
  { category: 'connections', label: 'Mail and calendar', description: 'whether your mail and calendar answer right now', topic: 'account', sectionId: 'account' },
  { category: 'flags', label: 'Features', description: 'every feature, on or off, and when a change takes effect', topic: 'general', sectionId: 'all' },
  { category: 'secure-address-now', label: 'Secure address now', description: 'what the https address serves now, why not when it does not, and each of the four ways explained', topic: 'general', sectionId: 'secure-address' },
];

/** The host fields shown only while their mode is `custom`. */
const NETWORK_HOST_MODES: Readonly<Record<string, string>> = { 'controlPlane.host': 'controlPlane.hostMode', 'httpListener.host': 'httpListener.hostMode', 'web.host': 'web.hostMode' };

const MCP_TRUST_MODES: readonly McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];

/** The tool rules a tool server's row opens, each its capability (Tools and extensions). */
const MCP_TOOL_RULES: readonly { readonly id: string; readonly capability: string; readonly label: string; readonly detail: string }[] = [
  { id: 'rule:block', capability: 'mcp.block', label: 'Block a tool', detail: 'Refuse every call to one of its tools.' },
  { id: 'rule:unblock', capability: 'mcp.unblock', label: 'Unblock a tool', detail: 'Let a blocked tool be called again.' },
  { id: 'rule:exempt', capability: 'mcp.exempt', label: 'Let a tool go beyond its limits', detail: 'Let one tool pass the server\'s folder and site limits.' },
  { id: 'rule:unexempt', capability: 'mcp.unexempt', label: 'Make a tool follow its limits again', detail: 'End a tool\'s exemption.' },
];

/** The setup steps each daemon answer implies for "Mail and calendar", in this screen's own words. */
const CONNECTION_STEPS: Readonly<Record<string, readonly string[]>> = {
  EMAIL_NOT_CONFIGURED: ['Set the mail server and your address in Account, Mail (this screen), then store the password in Permissions and safety, Secrets.'],
  EMAIL_CREDENTIALS_MISSING: ['Store the mail password in Permissions and safety, Secrets: the daemon keeps it, so it works with this program closed.'],
  CALENDAR_NOT_CONFIGURED: ['Set the calendar address and user in Account, Calendar (this screen), then store the password in Permissions and safety, Secrets.'],
};
const CONNECTION_METHODS = { mail: 'email.inbox.list', calendar: 'calendar.events.list' } as const;

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const direct = (error as { readonly code?: unknown }).code;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const body = (error as { readonly body?: unknown }).body;
  const nested = typeof body === 'object' && body !== null ? (body as { readonly code?: unknown }).code : undefined;
  return typeof nested === 'string' && nested.length > 0 ? nested : null;
}

/** A probe's answer as a row: only an answer counts as ready. */
function connectionRow(surface: ConnectionRow['surface'], error: unknown): ConnectionRow {
  const label = connectionLabel(surface);
  if (error === null) return { surface, state: 'ready', detail: `${label} is connected: the daemon reached the server and returned a result.`, nextActions: [] };
  const code = errorCode(error);
  const words = reasonOf(error);
  if (code !== null && code.endsWith('_CREDENTIALS_UNREADABLE')) {
    return { surface, state: 'unreadable', detail: asSentence(words), nextActions: ['Make the secret store readable on the daemon\'s computer (its key file must be the one the store was written with); nothing needs to be given again.'] };
  }
  const steps = code === null ? undefined : CONNECTION_STEPS[code];
  if (steps) return { surface, state: 'needs-setup', detail: asSentence(`${label} is not set up yet: ${words}`), nextActions: steps };
  if (code === 'METHOD_NOT_FOUND' || code === 'NOT_INVOKABLE') {
    return { surface, state: 'unreachable', detail: `This build's daemon does not serve ${surface} (${code}).`, nextActions: [`Update to a build whose daemon serves ${surface}.`] };
  }
  return { surface, state: 'unreachable', detail: asSentence(`${label} could not be checked: ${words}`), nextActions: ['Check that the daemon is running: System, Health.'] };
}

const CHECKING_CONNECTIONS: readonly ConnectionRow[] = (['mail', 'calendar'] as const).map((surface) => ({
  surface, state: 'checking' as const, detail: `Asking the daemon whether ${connectionLabel(surface).toLowerCase()} answers…`, nextActions: [],
}));

/** A key as the hint row draws it: the arrow keys as arrows ("shift+←"). */
function arrows(label: string): string {
  return label.split('/').map((one) => one.replace(/(^|\+)(up|down|left|right)$/, (_match, before: string, name: string) =>
    `${before}${name === 'up' ? '↑' : name === 'down' ? '↓' : name === 'left' ? '←' : '→'}`)).join('/');
}

/** A key or one typed character as a key token. */
function keyOf(token: InputToken): KeyToken | undefined {
  // Space is one key whether it arrives as typed text or as a named key; the table names it `space`.
  if (token.type === 'text') return token.value === '\t' ? { logicalName: 'tab' } : token.value === ' ' ? { logicalName: 'space' } : keyTokenFromText(token.value);
  if (token.type !== 'key') return undefined;
  return { logicalName: token.logicalName, ctrl: token.ctrl, shift: token.shift, meta: token.meta };
}

/** A value as the settings capability takes it typed: JSON, so a word stays text and a list stays a list. */
function valueText(key: string, value: unknown): string {
  if (isSecretConfigKey(key)) return typeof value === 'string' ? value : String(value ?? '');
  return JSON.stringify(value ?? '');
}

/** A change's target: the setting, who keeps it, and what it holds now. */
interface WriteTarget {
  readonly key: string;
  readonly label: string;
  readonly setting: ConfigSetting;
  readonly owner: 'daemon' | 'program';
  readonly current: unknown;
  readonly entry?: ScreenEntry | undefined;
}

const RESET = Symbol('reset');

/** The daemon's settings that apply only at its start: changing one restarts the daemon by itself. */
const RESTART_KEYS: ReadonlySet<string> = new Set(DAEMON_RESTART_SETTINGS.map((setting) => setting.key));

export class SettingsScreen implements SurfaceModal, HelpState {
  readonly name = 'settings';

  // -- what is shown ---------------------------------------------------------
  /** This program; and whose own settings are shown (the daemon's are the same in both). */
  readonly own: ScreenProgram;
  viewed: ScreenProgram;
  values: ValueState = { kind: 'reading' };
  groups = new Map<string, ScreenEntry[]>();
  topics: SettingsTopicView<ScreenEntry, ScreenList>[] = [];
  private searchEntries: ScreenEntry[] = [];
  mcpEntries: McpEntry[] = [];
  subscriptionEntries: SubscriptionEntry[] = [];
  connectionEntries: readonly ConnectionRow[] = CHECKING_CONNECTIONS;
  secureAddressRows: readonly SecureAddressRow[] = SECURE_ADDRESS_CHECKING_ROWS;
  featureEntries: ScreenFlag[] = [];

  // -- where the person is ---------------------------------------------------
  topicIndex = 0;
  openList: ScreenList | null = null;
  private openListRow = 0;
  selectedIndex = 0;
  focusRegion: 'categories' | 'settings' = 'categories';
  editingMode = false;
  editBuffer = '';
  /** The row being edited (kept while the values are read again under it). */
  private editKey: string | null = null;
  searchQuery = '';
  searchResults: ScreenEntry[] = [];
  contextScroll = 0;
  /** The sign-out the selected sign-in row waits for (never armed: a sign-out applies on Enter). */
  readonly subscriptionLogoutConfirmationTarget: string | null = null;
  readonly mcpAllowAllConfirmationTarget: string | null = null;

  // -- what happened -----------------------------------------------------------
  /** The line under the rows: what the last change became and how to put it back, or why it did not happen. */
  message: string | null = null;
  /** Why the daemon's change events are not followed now, so a change made elsewhere may not show yet. */
  private streamLost: string | undefined;
  private readSeq = 0;
  private closed = false;
  private readonly stops: Array<() => void> = [];
  private followStop: (() => void) | null = null;

  constructor(private readonly options: SettingsScreenOptions) {
    this.own = options.program.program;
    this.viewed = this.own;
    this.rebuild();
    this.follow();
    // The program's own daemon connection back (spine adoption, the Agent's attach): read and follow again, no key pressed.
    this.stops.push(options.host.onDaemonBack(() => { this.follow(); this.readValues(); if (this.openList === 'secure-address-now') this.readSecureAddress(); }));
    this.readValues();
  }

  // -- reading -----------------------------------------------------------------

  /** One event stream: the daemon's settings (the `config` domain) and the program settings, sign-ins and tool servers it changes. */
  private follow(): void {
    this.followStop?.();
    this.followStop = this.options.host.follow(
      // `machine-group`: the group or its certificate changed (here or on another machine): Secure address reads again.
      { domains: ['workspace', 'config'], events: ['config'], lists: ['settings', 'models', 'tools', 'machine-group'] },
      (change) => {
        this.readValues(); this.readLocalLists();
        // Only the group's own change re-reads Secure address: a setting written by its own row's act (serving other
        // machines) would otherwise wipe that act's outcome line as soon as it is said.
        if (this.openList === 'secure-address-now' && change?.list === 'machine-group') this.readSecureAddress();
      },
      (state: DaemonFrameStreamState) => {
        // The daemon back after its stream was lost (it restarted): what Secure address shows is read again.
        if (state.kind === 'open' && this.streamLost !== undefined && this.openList === 'secure-address-now') this.readSecureAddress();
        if (state.kind === 'open') this.streamLost = undefined;
        else this.streamLost = reasonOf(state.reason);
        this.redraw();
      },
    );
  }

  /** Read the values of the program shown (one `settings.list`), then the rows again. */
  readValues(): void {
    const seq = ++this.readSeq;
    const program = this.viewed;
    void runDaemonCapability('settings.list', { program }, this.options.context as never, this.options.binding).then(
      (answer) => {
        if (this.closed || seq !== this.readSeq || program !== this.viewed) return;
        const listed = listedValuesOf(answer.data);
        this.values = typeof listed === 'string' ? { kind: 'failed', reason: listed } : { kind: 'read', values: listed, at: Date.now() };
        this.rebuild();
        this.redraw();
      },
      (error: unknown) => {
        if (this.closed || seq !== this.readSeq || program !== this.viewed) return;
        this.values = { kind: 'failed', reason: reasonOf(error) };
        this.rebuild();
        this.redraw();
      },
    );
  }

  /** The lists this program keeps (its tool servers, the sign-ins it reads), read now. */
  private readLocalLists(): void {
    this.mcpEntries = buildMcpEntries(this.options.program.mcpRegistry ?? null);
    const subscriptions = this.options.program.subscriptions;
    this.subscriptionEntries = subscriptions ? buildSubscriptionEntries(subscriptions.manager, subscriptions.services) : [];
    if (this.openList === 'connections') this.readConnections();
  }

  private readConnections(): void {
    this.connectionEntries = CHECKING_CONNECTIONS;
    void Promise.all((['mail', 'calendar'] as const).map((surface) => this.options.host.invoke(CONNECTION_METHODS[surface], { limit: 1 }).then(
      () => connectionRow(surface, null),
      (error: unknown) => connectionRow(surface, error),
    ))).then((rows) => {
      if (this.closed) return;
      this.connectionEntries = rows;
      this.redraw();
    });
  }

  private readSecureAddress(): void {
    // The outcome of the last act pressed here stays said when the rows are read again (a rebind, the daemon back).
    const before = this.secureAddressRows;
    this.secureAddressRows = SECURE_ADDRESS_CHECKING_ROWS;
    void readSecureAddressRows((method, input) => this.options.host.invoke(method, input)).then((rows) => {
      if (this.closed) return;
      // The act's own answer may have landed while this read ran: its outcome is kept too.
      this.secureAddressRows = keepSecureAddressOutcome([...this.secureAddressRows, ...before], rows);
      this.redraw();
    });
  }

  /** The program's live gate states, when its own settings are shown. */
  private liveFlags(): FlagStates | null {
    if (this.viewed !== this.own) return null;
    const all = this.options.program.featureFlags?.getAll();
    if (!all) return null;
    const states = new Map<string, { readonly state: 'enabled' | 'disabled'; readonly pendingRestart: boolean }>();
    for (const [id, snapshot] of all) states.set(id, { state: snapshot.state === 'enabled' ? 'enabled' : 'disabled', pendingRestart: snapshot.pendingRestart });
    return states;
  }

  /** The rows again from what is known now, the selection kept on the same setting. */
  private rebuild(): void {
    const selectedKey = this.selectedKey();
    const flags = this.liveFlags();
    const registered = this.viewed === this.own && flags ? new Set(flags.keys()) : null;
    this.groups = buildScreenGroups({
      program: this.viewed, values: this.values, flags, registeredFeatures: registered,
      sourceRoot: this.options.program.configManager.getWorkingDirectory() ?? process.cwd(),
      daemonTierPath: this.options.program.configManager.getDaemonTierPath() ?? null,
    });
    this.topics = buildSettingsTopics(this.groups, TOPIC_LISTS);
    this.searchEntries = settingsTopicEntries(this.topics);
    this.featureEntries = featureListOf({ values: this.values, flags });
    if (this.searchQuery) this.searchResults = searchSettingsInOrder(this.searchQuery, this.searchEntries, getSettingLabel);
    if (selectedKey && this.openList === null) {
      const rows = this.searching ? this.searchResults.map((entry) => ({ kind: 'setting' as const, entry })) : this.visibleRows();
      const at = rows.findIndex((row) => row.kind === 'setting' && row.entry.setting.key === selectedKey);
      if (at >= 0) this.selectedIndex = at;
    }
  }

  private selectedKey(): string | null {
    return this.editKey ?? this.getSelected()?.setting.key ?? null;
  }

  // -- what is selected ------------------------------------------------------------

  get searching(): boolean { return this.searchQuery.length > 0; }
  /** The layout's word for a search being shown. */
  get searchFocused(): boolean { return this.searching; }
  get currentCategory(): string { return this.openList ?? 'topic'; }
  get topicLabel(): string { return this.topics[this.topicIndex]?.label ?? 'Settings'; }
  get topicRows(): readonly SettingsTopicRow<ScreenEntry, ScreenList>[] { return this.topics[this.topicIndex]?.rows ?? []; }
  get otherProgramKey(): string { return this.keyLabel(SETTINGS_KEYS.otherProgram, 'ctrl+o'); }
  get takesEveryKey(): boolean { return this.editingMode; }

  /** The chosen topic's rows as shown: a host field shows only while its mode is custom. */
  visibleRows(): readonly SettingsTopicRow<ScreenEntry, ScreenList>[] {
    const values = this.values.kind === 'read' ? this.values.values : undefined;
    return this.topicRows.filter((row) => {
      if (row.kind !== 'setting') return true;
      const mode = NETWORK_HOST_MODES[row.entry.setting.key];
      return mode === undefined || values?.get(mode)?.value === 'custom';
    });
  }

  private clamp(length: number): number { return Math.max(0, Math.min(this.selectedIndex, length - 1)); }

  getSelected(): ScreenEntry | null {
    if (this.searching) return this.searchResults[this.clamp(this.searchResults.length)] ?? null;
    if (this.openList !== null) return null;
    const rows = this.visibleRows();
    const row = rows[this.clamp(rows.length)];
    return row?.kind === 'setting' ? row.entry : null;
  }

  getSelectedListRow(): ScreenList | null {
    if (this.searching || this.openList !== null) return null;
    const rows = this.visibleRows();
    const row = rows[this.clamp(rows.length)];
    return row?.kind === 'list' ? row.list.category : null;
  }

  private selectedMcp(): McpEntry | null { return this.openList === 'mcp' ? this.mcpEntries[this.clamp(this.mcpEntries.length)] ?? null : null; }
  private selectedSubscription(): SubscriptionEntry | null { return this.openList === 'subscriptions' ? this.subscriptionEntries[this.clamp(this.subscriptionEntries.length)] ?? null : null; }
  private selectedFeature(): ScreenFlag | null { return this.openList === 'flags' ? this.featureEntries[this.clamp(this.featureEntries.length)] ?? null : null; }
  selectedConnection(): ConnectionRow | null { return this.openList === 'connections' ? this.connectionEntries[this.clamp(this.connectionEntries.length)] ?? null : null; }
  selectedSecureAddress(): SecureAddressRow | null { return this.openList === 'secure-address-now' ? this.secureAddressRows[this.clamp(this.secureAddressRows.length)] ?? null : null; }

  /** How many rows a list a topic opens holds, for its row. */
  listCount(list: ScreenList): string | undefined {
    const count = list === 'mcp' ? this.mcpEntries.length : list === 'subscriptions' ? this.subscriptionEntries.length
      : list === 'flags' ? this.featureEntries.length : list === 'connections' ? this.connectionEntries.length : 0;
    return count > 0 ? String(count) : undefined;
  }

  private itemCount(): number {
    if (this.searching) return this.searchResults.length;
    switch (this.openList) {
      case 'mcp': return this.mcpEntries.length;
      case 'subscriptions': return this.subscriptionEntries.length;
      case 'connections': return this.connectionEntries.length;
      case 'flags': return this.featureEntries.length;
      case 'secure-address-now': return this.secureAddressRows.length;
      default: return this.visibleRows().length;
    }
  }

  // -- moving ------------------------------------------------------------------

  /** Choose a topic; its first row is selected and any open list closes. */
  selectTopic(index: number): void {
    if (this.editingMode || this.topics.length === 0) return;
    this.topicIndex = ((index % this.topics.length) + this.topics.length) % this.topics.length;
    this.openList = null;
    this.selectedIndex = 0;
    this.contextScroll = 0;
    this.message = null;
  }

  private move(delta: -1 | 1): void {
    if (this.editingMode) return;
    this.contextScroll = 0;
    if (!this.searching && this.focusRegion === 'categories') { this.selectTopic(this.topicIndex + delta); return; }
    const count = this.itemCount();
    if (count > 0) this.selectedIndex = (this.clamp(count) + delta + count) % count;
    // The outcome of a change belongs to the row it was made on: it is fresh until the selection moves.
    this.message = null;
  }

  private openTopicList(list: ScreenList): void {
    this.openListRow = this.openList === null ? this.selectedIndex : this.openListRow;
    this.openList = list;
    this.selectedIndex = 0;
    this.contextScroll = 0;
    this.focusRegion = 'settings';
    this.message = null;
    if (list === 'mcp' || list === 'subscriptions') this.readLocalLists();
    else if (list === 'connections') this.readConnections();
    else if (list === 'secure-address-now') this.readSecureAddress();
  }

  /** Close the list a topic row opened, back on that row; false when none was open. */
  private leaveList(): boolean {
    if (this.openList === null || this.editingMode) return false;
    this.openList = null;
    this.selectedIndex = this.openListRow;
    this.contextScroll = 0;
    this.focusRegion = 'settings';
    return true;
  }

  private setSearch(query: string): void {
    if (query !== this.searchQuery) this.message = null;
    this.searchQuery = query;
    this.searchResults = query.trim().length === 0 ? [] : searchSettingsInOrder(query, this.searchEntries, getSettingLabel);
    this.selectedIndex = 0;
    this.contextScroll = 0;
  }

  /** Lands on a topic, a list or a setting; any other text becomes the search, and the outcome says which. */
  selectTarget(target?: string): SettingsTargetOutcome {
    const wanted = target?.trim();
    if (!wanted) return 'none';
    const found = findSettingsTopicTarget(this.topics, wanted, getSettingLabel);
    if (!found) {
      this.setSearch(wanted);
      return 'not-found';
    }
    this.setSearch('');
    this.selectTopic(found.topicIndex);
    const row = this.topicRows[found.rowIndex];
    this.selectedIndex = Math.max(0, this.visibleRows().findIndex((candidate) => candidate === row));
    this.focusRegion = 'settings';
    if (found.kind === 'list') this.openTopicList(found.category);
    return found.kind === 'setting' ? 'setting' : 'category';
  }

  // -- keys --------------------------------------------------------------------

  private keyLabel(name: string, fallback: string): string {
    return arrows(keycapOf(this.options.host.keys, `${SETTINGS_KEY_CONTEXT_ID}.${name}`, fallback));
  }

  private navLabel(name: string, fallback: string): string {
    return arrows(keycapOf(this.options.host.keys, name, fallback));
  }

  /** Whether a key is bound, in the program's table, to a global action (the page keys). */
  private boundTo(action: string, key: KeyToken): boolean {
    const combos = this.options.host.keys.getAll().find((entry) => entry.action === action)?.combos ?? [];
    return combos.some((bound) => !bound.leader && bound.key === key.logicalName && !bound.ctrl === !key.ctrl && !bound.shift === !key.shift && !bound.alt === !key.meta);
  }

  handleToken(token: InputToken, _host: SurfaceModalHost): void {
    if (token.type === 'mouse' || token.type === 'focus') return;
    const read = keyOf(token);
    const names = read ? [
      ...this.options.host.keys.lookupInContext(SETTINGS_KEY_CONTEXT_ID, read),
      // A key written as text in keybindings.json ("space" reads back as a space) is the same key.
      ...(read.logicalName === 'space' ? this.options.host.keys.lookupInContext(SETTINGS_KEY_CONTEXT_ID, { ...read, logicalName: ' ' }) : []),
    ] : [];
    if (this.editingMode) {
      if (names.includes(SETTINGS_KEYS.erase)) this.editBuffer = this.editBuffer.slice(0, -1);
      else this.editToken(token);
      this.redraw();
      return;
    }
    // Space: acts on the selected row with no filter typed; with a filter it is a space in it.
    if (names.includes(SETTINGS_KEYS.act) && !this.searching) { this.activate(); this.redraw(); return; }
    if (names.includes(SETTINGS_KEYS.erase)) { if (this.searching) this.setSearch(this.searchQuery.slice(0, -1)); this.redraw(); return; }
    if (names.includes(SETTINGS_KEYS.reset)) { this.openReset(); this.redraw(); return; }
    if (names.includes(SETTINGS_KEYS.otherProgram)) { this.switchProgram(); this.redraw(); return; }
    if (names.includes(SETTINGS_KEYS.readAgain)) { this.message = null; this.readValues(); this.readLocalLists(); if (this.openList === 'secure-address-now') this.readSecureAddress(); this.redraw(); return; }
    if (names.includes(SETTINGS_KEYS.adjustDown) || names.includes(SETTINGS_KEYS.adjustUp)) { void this.adjust(names.includes(SETTINGS_KEYS.adjustUp) ? 'right' : 'left'); this.redraw(); return; }
    if (read && this.boundTo('scroll-page-down', read)) { this.contextScroll += 3; this.redraw(); return; }
    if (read && this.boundTo('scroll-page-up', read)) { this.contextScroll = Math.max(0, this.contextScroll - 3); this.redraw(); return; }
    if (token.type === 'key') {
      const key = token.logicalName;
      if (key === 'up') this.move(-1);
      else if (key === 'down') this.move(1);
      else if (key === 'enter') this.activate();
      else if (key === 'space' && this.searching) this.setSearch(`${this.searchQuery} `);
      else if (key === 'left' && !this.searching) { if (!this.leaveList()) this.focusRegion = 'categories'; }
      else if (key === 'right' && !this.searching) this.focusRegion = 'settings';
      else if (key === 'tab') {
        if (this.searching) { this.setSearch(''); this.focusRegion = 'categories'; }
        else this.focusRegion = this.focusRegion === 'settings' ? 'categories' : 'settings';
      }
      this.redraw();
      return;
    }
    // Typed text is the search ("/" alone opens nothing: a search does not start with it).
    if (this.searching || (token.value !== '/' && token.value !== ' ')) this.setSearch(this.searchQuery + token.value);
    this.redraw();
  }

  private editToken(token: InputToken): void {
    if (token.type === 'key') {
      if (token.logicalName === 'enter') void this.commitEdit();
      else if (token.logicalName === 'space') this.editBuffer += ' ';
      return;
    }
    if (token.type === 'text') this.editBuffer += token.value;
  }

  escape(): boolean {
    if (this.editingMode) { this.cancelEdit(); this.redraw(); return true; }
    if (this.searching) { this.setSearch(''); this.redraw(); return true; }
    if (this.leaveList()) { this.redraw(); return true; }
    return false;
  }

  onClose(_reason: SurfaceModalCloseReason): void {
    this.closed = true;
    this.followStop?.();
    this.followStop = null;
    for (const stop of this.stops.splice(0)) stop();
    this.options.closed?.();
  }

  private redraw(): void {
    if (!this.closed) this.options.host.requestRender();
  }

  private close(): void {
    this.options.close(this);
  }

  /** Show the other program's own settings, or this one's again; the daemon's are the same in both. */
  private switchProgram(): void {
    if (this.editingMode) return;
    this.viewed = this.viewed === 'tui' ? 'agent' : 'tui';
    this.values = { kind: 'reading' };
    this.message = null;
    this.rebuild();
    this.readValues();
  }

  // -- acting ------------------------------------------------------------------

  /** Enter (or Space) on the selected row. */
  activate(): void {
    if (!this.searching && this.focusRegion === 'categories') { this.focusRegion = 'settings'; return; }
    const list = this.getSelectedListRow();
    if (list !== null) { this.openTopicList(list); return; }
    if (!this.searching && this.openList !== null) { void this.activateListRow(); return; }
    const entry = this.getSelected();
    if (entry) void this.activateEntry(entry);
  }

  private async activateListRow(): Promise<void> {
    switch (this.openList) {
      case 'mcp': { const server = this.selectedMcp(); if (server) this.chooseMcp(server); return; }
      case 'subscriptions': { const sign = this.selectedSubscription(); if (sign) await this.signOut(sign); return; }
      case 'flags': { const flag = this.selectedFeature(); if (flag) await this.setFeature(flag, flag.state !== 'enabled'); return; }
      case 'secure-address-now': {
        const row = this.selectedSecureAddress();
        if (!row?.action) return;
        // Asking first ("Replace the authority") or answering No changes the rows only; the rest wait on the daemon.
        if (row.action !== 'replace-authority' && row.action !== 'keep-authority') {
          this.secureAddressRows = this.secureAddressRows.map((candidate) => candidate === row ? { ...candidate, state: 'working…' } : candidate);
          this.redraw();
        }
        const rows = await runSecureAddressRowAction((method, input) => this.options.host.invoke(method, input), row, this.secureAddressRows);
        if (this.closed || !rows) return;
        this.secureAddressRows = rows;
        this.redraw();
        return;
      }
      default: return;
    }
  }

  /** Why a row cannot be changed now, or undefined when it can. */
  private refusal(entry: ScreenEntry): string | undefined {
    if (entry.metadataUnavailable) return `Not changed: ${asSentence(entry.metadataUnavailable)}`;
    if (entry.locked) return `Not changed: ${asSentence(entry.lockReason ? `locked, ${entry.lockReason}` : 'it is locked by a setting that takes priority over this one')}`;
    if (entry.effectiveSource === 'unavailable' && entry.currentValue === undefined) {
      return entry.sourceLabel?.startsWith('reading')
        ? 'Not changed yet: the value is still being read from the daemon.'
        : `Not changed: its value ${entry.sourceLabel ?? 'could not be read'}. ${this.keyLabel(SETTINGS_KEYS.readAgain, 'ctrl+l')} reads it again.`;
    }
    return undefined;
  }

  private targetOf(entry: ScreenEntry): WriteTarget {
    return { key: entry.setting.key, label: getSettingLabel(entry), setting: entry.setting, owner: entry.owner, current: entry.currentValue, entry };
  }

  private async activateEntry(entry: ScreenEntry): Promise<void> {
    const { setting } = entry;
    if (entry.cards) {
      // Cards are the Money place's: Settings closes and Money opens on its Cards tab.
      this.close();
      void openPaymentsCardsFromSettings(this.options.context).finally(() => this.options.host.requestRender());
      return;
    }
    const refused = this.refusal(entry);
    if (refused) { this.message = refused; return; }
    if (entry.flag) { await this.setFeature(entry.flag, entry.flag.state !== 'enabled', entry); return; }
    const choice = SETTINGS_CHOICE_ACTIONS[setting.key];
    if (choice) { this.openChoice(choice); return; }
    if (setting.key === 'provider.decisionRouter') { openDecisionRouterSettings(this.pickerContext() as unknown as DecisionRouterPickerContext, () => this.afterPicker()); return; }
    if (setting.key === 'tts.provider') { this.options.program.pickers.ttsProvider(this.pickerContext()); return; }
    if (setting.key === 'tts.voice') { void Promise.resolve(this.options.program.pickers.ttsVoice(this.pickerContext())).catch((error: unknown) => { this.message = `The voices could not be listed: ${reasonOf(error)}.`; this.redraw(); }); return; }
    if (setting.key === 'display.theme') { this.options.program.pickers.theme(this.pickerContext()); return; }
    if (setting.key === 'daemon.timezone') { this.chooseTimezone(entry); return; }
    if (modelPickerLaunchForKey(setting.key) !== null) { this.chooseModel(entry); return; }
    if (/(^|\.)reasoningEffort$/.test(setting.key)) { this.chooseLevel(entry); return; }
    if (setting.type === 'boolean') { await this.write(this.targetOf(entry), entry.currentValue !== true); return; }
    if (setting.type === 'enum' && setting.enumValues) { this.chooseEnum(entry); return; }
    // A value is typed in a plain field (hidden as it is typed for a password or key).
    this.editingMode = true;
    this.editKey = setting.key;
    this.editBuffer = listEditText(entry)
      ?? (isSecretConfigKey(setting.key) ? '' : setting.type === 'object' ? JSON.stringify(entry.currentValue ?? {}) : String(entry.currentValue ?? ''));
  }

  private cancelEdit(): void {
    this.editingMode = false;
    this.editBuffer = '';
    this.editKey = null;
  }

  private editedEntry(): ScreenEntry | null {
    if (!this.editKey) return null;
    for (const entries of this.groups.values()) for (const entry of entries) if (entry.setting.key === this.editKey) return entry;
    return null;
  }

  /** Enter in a field: the typed value, checked here as the setting checks it, then changed through the capability. */
  private async commitEdit(): Promise<void> {
    const entry = this.editedEntry();
    if (!entry) { this.cancelEdit(); return; }
    const { setting } = entry;
    const text = this.editBuffer;
    const reject = (reason: string): void => { this.message = `Not changed: ${reason} The field is still open: correct it, or Esc leaves it as it was.`; };
    let value: unknown = text;
    const listEdit = parseListEdit(entry, text);
    if (listEdit) {
      if (!listEdit.ok) { reject(asSentence(listEdit.reason)); return; }
      value = listEdit.value;
    } else if (setting.type === 'number') {
      const number = parseNumberEditBuffer(text);
      if (number === null) { reject(`"${text}" is not a number.`); return; }
      value = number;
    } else if (setting.type === 'object') {
      try { value = JSON.parse(text) as unknown; } catch { reject('that is not valid JSON.'); return; }
    }
    if (!listEdit && !isSecretConfigKey(setting.key) && setting.validate && !setting.validate(value)) {
      reject(`"${text}" is not accepted${setting.validationHint ? ` (${setting.validationHint})` : ''}.`);
      return;
    }
    this.cancelEdit();
    await this.write(this.targetOf(entry), value);
  }

  /** Shift and an arrow: the next or previous choice, a step of a number, on or off; a list's row its own way. */
  private async adjust(direction: 'left' | 'right'): Promise<void> {
    if (this.editingMode) return;
    if (!this.searching && this.openList === 'mcp') {
      const server = this.selectedMcp();
      const next = server ? cycleSettingChoice(MCP_TRUST_MODES, server.trustMode, direction) : undefined;
      if (server && next) await this.setTrust(server, next);
      return;
    }
    if (!this.searching && this.openList === 'flags') {
      const flag = this.selectedFeature();
      if (flag) await this.setFeature(flag, direction === 'right');
      return;
    }
    const entry = this.getSelected();
    if (!entry || entry.cards) return;
    const refused = this.refusal(entry);
    if (refused) { this.message = refused; return; }
    if (entry.flag) { await this.setFeature(entry.flag, direction === 'right', entry); return; }
    const key = entry.setting.key;
    // Rows whose value is chosen in a list or a picker are changed there, not nudged.
    if (SETTINGS_CHOICE_ACTIONS[key] !== undefined || modelPickerLaunchForKey(key) !== null
      || key === 'tts.provider' || key === 'tts.voice' || key === 'display.theme' || key === 'daemon.timezone') return;
    const adjusted = adjustedSettingValue(entry.setting, entry.currentValue, direction, 1);
    if (adjusted && JSON.stringify(adjusted.value) !== JSON.stringify(entry.currentValue)) await this.write(this.targetOf(entry), adjusted.value);
  }

  /**
   * One change, through the settings capability, as the owner's own press: a change that loosens a protection asks
   * first (opening on No); the line under the rows says what it became and how to put it back, or why not.
   */
  private async write(target: WriteTarget, value: unknown): Promise<boolean> {
    const reset = value === RESET;
    const next = reset ? programDefaultOf(target.setting) : value;
    const facts = configKeyFacts(target.key);
    // A stored credential reset is removed from the secret store: asked first, since only giving it again brings it back.
    if (reset && isSecretConfigKey(target.key)) {
      if (target.current === undefined || target.current === '') { this.message = `${target.label} is not set: there is nothing stored to remove.`; this.redraw(); return false; }
      const asked = await this.options.host.confirm({
        title: 'Remove the stored credential?',
        body: `${target.label} is removed from the secret store for every program. It cannot be put back from here: only giving it again brings it back.`,
        confirmLabel: 'Remove it',
      });
      if (!asked) { this.message = `Not changed: ${target.label} stays stored.`; this.redraw(); return false; }
    }
    if (facts.loosens?.(target.current, next)) {
      const asked = await this.options.host.confirm({
        title: 'Loosen a protection?',
        body: `${target.label} goes from ${this.words(target, target.current)} to ${this.words(target, next)}${target.owner === 'daemon' ? ', for every program' : `, in ${programName(this.viewed)}`}: it would ${facts.loosening ?? 'loosen a protection'}.`,
        confirmLabel: 'Change it',
      });
      if (!asked) { this.message = `Not changed: ${target.label} stays ${this.words(target, target.current)}.`; this.redraw(); return false; }
    }
    const program = target.owner === 'daemon' ? this.own : this.viewed;
    this.message = `Changing ${target.label}…`;
    this.redraw();
    try {
      const values: ActionValues = reset ? { key: target.key, program } : { key: target.key, value: valueText(target.key, next), program };
      const answer = await runDaemonCapability(reset ? 'settings.reset' : 'settings.set', values, this.options.context as never, this.options.binding);
      const data = answer.data ?? {};
      if (data['pending'] === true) {
        this.message = asSentence(answer.text ?? `${target.label} is put to the owner; it changes once approved`);
      } else {
        const held = Object.hasOwn(data, 'value') ? data['value'] : next;
        // "Not set" is the row's word; inside a sentence it is "not set".
        const inline = (words: string): string => (words === 'Not set' ? 'not set' : words);
        const now = isSecretConfigKey(target.key) ? (reset ? 'not set: it is removed from the secret store' : 'stored in the secret store (hidden)') : inline(this.words(target, held));
        const was = inline(this.words(target, target.current));
        const back = reset
          ? `It was ${was}; change it to ${was} again to put it back.`
          : `It was ${was}; change it back to ${was}, or ${this.keyLabel(SETTINGS_KEYS.reset, 'ctrl+r')} puts the default (${inline(this.words(target, programDefaultOf(target.setting)))}) back.`;
        const lines = [`${target.label} is now ${now}${target.owner === 'program' && this.viewed !== this.own ? ` in ${programName(this.viewed)}` : ''}.`, isSecretConfigKey(target.key) ? '' : back];
        if (target.key === 'payments.cvvHandling' && next === 'prompt') lines.push(CVV_PROMPT_TRADEOFF_WARNING);
        if (RESTART_KEYS.has(target.key)) lines.push('It applies when the daemon starts: run by a service manager, the daemon restarts itself now and this screen reads again when it is back; otherwise the change is kept for its next start, and the daemon tells you so.');
        // What this program does itself after its own or a daemon setting changed (a theme applied, the service installed).
        if (target.owner === 'daemon' || this.viewed === this.own) {
          try {
            const after = this.options.program.afterChange?.({ key: target.key, previousValue: target.current, value: held });
            if (after && after.message) lines.push(asSentence(after.message));
          } catch (error) { lines.push(`It changed, but ${programName(this.own)} could not apply it here: ${reasonOf(error)}.`); }
        }
        this.message = lines.filter(Boolean).join(' ');
        if (target.entry) {
          target.entry.currentValue = isSecretConfigKey(target.key) ? (reset ? '' : '(hidden)') : held;
          target.entry.isDefault = JSON.stringify(held) === JSON.stringify(target.setting.default);
        }
      }
      this.readValues();
      this.redraw();
      return true;
    } catch (error) {
      this.message = `Not changed: ${asSentence(reasonOf(error))}`;
      // The transcript keeps a refusal that comes back after the screen closed.
      if (this.closed) this.options.context.print(`[Settings] ${target.label} was not changed: ${reasonOf(error)}`);
      this.redraw();
      return false;
    }
  }

  /**
   * A choice that sets several settings at once: all of them or none. A loosening among them asks once; each is
   * written through the settings capability, secrets last; when one is refused, the ones already written go back to
   * what they held, and the line under the rows says nothing changed and why. Every key comes back refused then.
   */
  private async writeAll(items: ReadonlyArray<{ readonly change: { readonly key: string; readonly value: unknown }; readonly target: WriteTarget | undefined }>): Promise<Array<{ readonly key: string; readonly error: unknown }>> {
    const refuseAll = (reason: string): Array<{ readonly key: string; readonly error: unknown }> => {
      this.message = `Nothing changed: ${reason}`;
      this.redraw();
      return items.map((item) => ({ key: item.change.key, error: new Error(reason) }));
    };
    const unknown = items.find((item) => item.target === undefined);
    if (unknown) return refuseAll(`${unknown.change.key} is not a setting this screen knows.`);
    const planned = items
      .map((item) => ({ key: item.change.key, value: item.change.value, target: item.target! }))
      .filter((item) => isSecretConfigKey(item.key) || JSON.stringify(item.value) !== JSON.stringify(item.target.current))
      .sort((a, b) => Number(isSecretConfigKey(a.key)) - Number(isSecretConfigKey(b.key)));
    if (planned.length === 0) { this.message = 'Nothing changed: every setting of this choice already holds that value.'; this.redraw(); return []; }
    const loosening = planned.filter((item) => configKeyFacts(item.key).loosens?.(item.target.current, item.value));
    if (loosening.length > 0) {
      const asked = await this.options.host.confirm({
        title: 'Loosen a protection?',
        body: loosening.map((item) => `${item.target.label} goes from ${this.words(item.target, item.target.current)} to ${this.words(item.target, item.value)}: it would ${configKeyFacts(item.key).loosening ?? 'loosen a protection'}.`).join(' '),
        confirmLabel: 'Change it',
      });
      if (!asked) return refuseAll('the change was not confirmed, so every setting stays as it was.');
    }
    this.message = `Changing ${planned.map((item) => item.target.label).join(', ')}…`;
    this.redraw();
    const written: typeof planned = [];
    const run = (id: 'settings.set' | 'settings.reset', item: (typeof planned)[number], value?: unknown) => runDaemonCapability(id, {
      key: item.key, program: item.target.owner === 'daemon' ? this.own : this.viewed, ...(id === 'settings.set' ? { value: valueText(item.key, value) } : {}),
    }, this.options.context as never, this.options.binding);
    for (const item of planned) {
      try {
        const answer = await run('settings.set', item, item.value);
        if ((answer.data ?? {})['pending'] === true) throw new Error(`${item.target.label} waits for the owner's approval, and a choice is made whole or not at all`);
        written.push(item);
      } catch (error) {
        const notBack: string[] = [];
        for (const done of [...written].reverse()) {
          try {
            if (isSecretConfigKey(done.key)) throw new Error('a stored secret cannot be read back');
            if (done.target.current === undefined) await run('settings.reset', done);
            else await run('settings.set', done, done.target.current);
          } catch (backError) { notBack.push(`${done.target.label} (${reasonOf(backError)})`); }
        }
        this.readValues();
        const putBack = written.length === 0 ? '' : notBack.length === 0
          ? ` The ${written.length === 1 ? 'one' : `${written.length}`} already written ${written.length === 1 ? 'was' : 'were'} put back.`
          : ` These could not be put back and hold the new value: ${notBack.join('; ')}.`;
        const result = refuseAll(`${item.target.label} was refused (${reasonOf(error).replace(/[.\s]+$/, '')}).${putBack}`);
        if (notBack.length > 0) { this.message = `Not all put back: ${item.target.label} was refused (${reasonOf(error).replace(/[.\s]+$/, '')}).${putBack}`; this.redraw(); }
        return result;
      }
    }
    this.message = `${planned.map((item) => `${item.target.label} is now ${isSecretConfigKey(item.key) ? 'stored in the secret store (hidden)' : this.words(item.target, item.value)}`).join('; ')}.`;
    this.readValues();
    this.redraw();
    return [];
  }

  /** A value of a setting as a person reads it. */
  private words(target: WriteTarget, value: unknown): string {
    const probe: ScreenEntry = { setting: target.setting, owner: target.owner, currentValue: value, isDefault: false, ...(target.entry?.editor ? { editor: target.entry.editor } : {}) };
    if (target.entry?.editor === 'worktree' && typeof value !== 'string') {
      applyValue(probe, { kind: 'read', values: new Map([[target.key, { value }]]), at: 0 });
    }
    return formatValue(probe);
  }

  /** A feature on or off: the single settings write of its switch. */
  private async setFeature(flag: ScreenFlag, on: boolean, entry?: ScreenEntry): Promise<void> {
    if (isFeatureValueEnabled(flag.feature, entry?.currentValue ?? this.valueOf(flag.feature.enablement.key)) === on) return;
    const write = featureEnablementWrite(flag.feature.id, on);
    if (!write) { this.message = `${flag.feature.name} has no off position: its own settings govern it.`; return; }
    const setting = entry?.setting ?? this.settingOf(write.key);
    if (!setting) return;
    const target: WriteTarget = {
      key: write.key, label: flag.feature.name, setting, owner: isDaemonOwnedConfigKey(write.key) ? 'daemon' : 'program',
      current: entry?.currentValue ?? this.valueOf(write.key), entry,
    };
    const done = await this.write(target, write.value);
    if (done && flag.feature.restartRequired && this.message) this.message += ` It takes effect the next time ${programName(this.viewed)} starts.`;
  }

  private valueOf(key: string): unknown {
    return this.values.kind === 'read' ? this.values.values.get(key)?.value : undefined;
  }

  private settingOf(key: string): ConfigSetting | undefined {
    for (const entries of this.groups.values()) for (const entry of entries) if (entry.setting.key === key) return entry.setting;
    return undefined;
  }

  private entryOf(key: string): ScreenEntry | undefined {
    for (const entries of this.groups.values()) for (const entry of entries) if (entry.setting.key === key) return entry;
    return undefined;
  }

  // -- lists of choices --------------------------------------------------------------

  private open(title: string, items: SelectionItem[], preSelectId: string | undefined, chosen: (id: string) => void, allowSearch = false): void {
    const open = this.options.context.openSelection;
    if (!open) { this.message = 'This program cannot show a list of choices here.'; return; }
    open(title, items, { ...(preSelectId !== undefined ? { preSelectId } : {}), allowSearch }, (result) => { if (result) chosen(result.item.id); this.redraw(); });
  }

  /** A choice is a list: each value in words with what it does, opening on the one in force. */
  private chooseEnum(entry: ScreenEntry): void {
    const { setting } = entry;
    const meanings = this.enumMeanings(setting.key);
    const items: SelectionItem[] = (setting.enumValues ?? []).map((value) => {
      const meaning = meanings[value];
      return {
        id: value,
        label: setting.enumLabels?.[value] ?? settingChoiceWords(setting.key, value),
        ...(meaning ? { detail: meaning } : {}),
        ...(value === programDefaultOf(setting) ? { right: 'default' } : {}),
        primaryAction: 'select' as const,
      };
    });
    this.open(getSettingLabel(entry), items, String(entry.currentValue ?? ''), (id) => {
      if (id !== entry.currentValue) void this.write(this.targetOf(entry), id);
    });
  }

  private enumMeanings(key: string): Readonly<Record<string, string>> {
    return enumMeaningsOf(this.viewed)[key] ?? {};
  }

  /** How hard the model thinks: the known levels, as a list (each model takes the nearest it accepts). */
  private chooseLevel(entry: ScreenEntry): void {
    const current = String(entry.currentValue ?? '');
    const items: SelectionItem[] = REASONING_EFFORT_SEVERITY.map((level) => ({
      id: level, label: settingChoiceWords(entry.setting.key, level), ...(level === programDefaultOf(entry.setting) ? { right: 'default' } : {}), primaryAction: 'select' as const,
    }));
    this.open(getSettingLabel(entry), items, current || undefined, (id) => {
      if (id !== current) void this.write(this.targetOf(entry), id);
    });
  }

  /** daemon.timezone: every zone this machine knows, and UTC (unset); never typed, so no typo reaches the daemon. */
  private chooseTimezone(entry: ScreenEntry): void {
    const current = String(entry.currentValue ?? '');
    const unset = '__utc__';
    const items: SelectionItem[] = [
      { id: unset, label: 'UTC (unset)', detail: 'Clears the daemon\'s time zone: days roll over at midnight UTC.', primaryAction: 'select' },
      ...Intl.supportedValuesOf('timeZone').map((zone) => ({ id: zone, label: zone, ...(zone === current ? { right: 'in force' } : {}), primaryAction: 'select' as const })),
    ];
    this.open(getSettingLabel(entry), items, current || unset, (id) => {
      const zone = id === unset ? '' : id;
      if (zone !== current) void this.write(this.targetOf(entry), zone);
    }, true);
  }

  /** A row naming a model or a provider: a list of the ones this program can use, and the empty choice where it means one. */
  private chooseModel(entry: ScreenEntry): void {
    const key = entry.setting.key;
    const launch = modelPickerLaunchForKey(key);
    const models = this.viewed === this.own ? this.options.program.models?.() ?? [] : this.otherProgramModels();
    const current = String(entry.currentValue ?? '');
    const empty = { id: '__empty__', label: 'Not set', detail: asSentence(entry.setting.description), primaryAction: 'select' as const };
    let items: SelectionItem[];
    if (key === 'provider.model') {
      items = models.map((model) => ({ id: `${model.provider}:${model.id}`, label: model.displayName ?? model.id, category: model.provider, primaryAction: 'select' as const }));
    } else if (launch?.flow === 'providerModel') {
      items = [empty, ...[...new Set(models.map((model) => model.provider))].sort().map((provider) => ({ id: provider, label: provider, primaryAction: 'select' as const }))];
    } else {
      const providerKey = key.replace(/Model$/, 'Provider').replace('globalModel', 'globalProvider');
      const provider = String(this.valueOf(providerKey) ?? '');
      items = [empty, ...models.filter((model) => !provider || model.provider === provider).map((model) => ({ id: model.id, label: model.displayName ?? model.id, category: model.provider, primaryAction: 'select' as const }))];
    }
    if (items.length === 0) { this.message = `No model is listed in ${programName(this.own)} to choose from: Models and providers sets one up.`; return; }
    this.open(getSettingLabel(entry), items, current || (items[0]?.id ?? undefined), (id) => {
      const value = id === '__empty__' ? '' : id;
      if (value !== current) void this.write(this.targetOf(entry), value);
    }, true);
  }

  /**
   * The models the other program can use: the built-in and daemon-listed ones both programs share (this program's
   * list without the providers only this program adds in its own folder), and the providers the other program adds
   * in its own folder (~/.goodvibes/<program>/providers), read from their files as it reads them.
   */
  private otherProgramModels(): readonly { readonly id: string; readonly provider: string; readonly displayName?: string | undefined }[] {
    const own = this.options.program.models?.() ?? [];
    const ownDir = this.options.program.configManager.getCustomProvidersDir?.();
    // Only when this program's folder is the usual ~/.goodvibes/<program>/providers is the other's beside it.
    if (!ownDir || basename(dirname(ownDir)) !== this.own) return own;
    const otherDir = join(dirname(dirname(ownDir)), this.viewed, basename(ownDir));
    const filesOf = (dir: string): Array<{ readonly name: string; readonly models: readonly { readonly id: string; readonly displayName?: string | undefined }[] }> => {
      let names: string[];
      try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
      return names.flatMap((name) => {
        try {
          const data = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as { readonly name?: unknown; readonly models?: unknown };
          if (typeof data.name !== 'string' || !Array.isArray(data.models)) return [];
          const models = (data.models as unknown[]).flatMap((model) => {
            const record = model as { readonly id?: unknown; readonly displayName?: unknown };
            return typeof record?.id === 'string' ? [{ id: record.id, ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}) }] : [];
          });
          return [{ name: data.name, models }];
        } catch { return []; }
      });
    };
    const ownCustom = new Set(filesOf(ownDir).map((file) => file.name));
    const shared = own.filter((model) => !ownCustom.has(model.provider));
    const theirs = filesOf(otherDir).flatMap((file) => file.models.map((model) => ({ id: model.id, provider: file.name, displayName: model.displayName })));
    const seen = new Set(shared.map((model) => `${model.provider}:${model.id}`));
    return [...shared, ...theirs.filter((model) => !seen.has(`${model.provider}:${model.id}`))];
  }

  /**
   * The context a picker this screen opens writes through: every write it makes is a `settings.set` from this
   * screen (the same capability, the same question before a loosening change), never the program's own store.
   */
  private pickerContext(): CommandActionContext {
    const local = this.options.program.configManager;
    const read = (key: string): unknown => (this.values.kind === 'read' && this.values.values.has(key) ? this.values.values.get(key)!.value : local.get(key as ConfigKey));
    const setDynamic = (key: string, value: unknown): void => {
      const entry = this.entryOf(key);
      const setting = entry?.setting ?? this.settingOf(key);
      if (!setting) { this.message = `Not changed: ${key} is not a setting this screen knows.`; this.redraw(); return; }
      void this.write(entry ? this.targetOf(entry) : { key, label: setting.label, setting, owner: isDaemonOwnedConfigKey(key) ? 'daemon' : 'program', current: read(key) }, value);
    };
    const setMany = (changes: ReadonlyArray<{ readonly key: string; readonly value: unknown }>): unknown => {
      const pending = this.writeAll(changes.map((change) => {
        const entry = this.entryOf(change.key);
        const setting = entry?.setting ?? this.settingOf(change.key);
        return { change, target: setting ? (entry ? this.targetOf(entry) : { key: change.key, label: setting.label, setting, owner: isDaemonOwnedConfigKey(change.key) ? 'daemon' as const : 'program' as const, current: read(change.key) }) : undefined };
      }));
      return { ok: true, saved: changes.map((change) => change.key), pending: { settle: () => pending } };
    };
    const config = { routesThroughDaemon: true as const, get: read, setDynamic, setMany, defaultOf: (key: string) => programDefaultOf(this.settingOf(key) ?? { key: key as ConfigKey, default: undefined }) };
    const context = this.options.context as CommandActionContext & { readonly platform?: Record<string, unknown> };
    return { ...context, platform: { ...(context.platform ?? {}), configManager: config }, renderRequest: () => this.redraw() } as CommandActionContext;
  }

  private afterPicker(): void {
    this.readValues();
    this.redraw();
  }

  /** The judgment, permission, decision and payments choices: the shared lists, writing through this screen. */
  private openChoice(action: SettingsChoiceAction): void {
    const context = this.pickerContext() as unknown as SettingsChoiceContext;
    if (action === 'decision-router') { openDecisionRouterSettings(context as unknown as DecisionRouterPickerContext, () => this.afterPicker()); return; }
    const mode = (value: string): void => {
      const entry = this.entryOf('permissions.mode');
      if (entry) void this.write(this.targetOf(entry), value);
    };
    if (!openSettingsChoice(context, action, () => this.afterPicker(), mode)) this.message = 'This program cannot show a list of choices here.';
  }

  // -- tool servers, sign-ins ------------------------------------------------------

  /** A tool server's row: the trust levels and the tool rules, as a list. */
  private chooseMcp(server: McpEntry): void {
    const items: SelectionItem[] = [
      ...MCP_TRUST_MODES.map((mode) => {
        const level = MCP_TRUST_LEVEL_WORDS.find((candidate) => candidate.value === mode);
        return { id: `trust:${mode}`, label: level?.label ?? mode, ...(level ? { detail: level.help } : {}), ...(mode === server.trustMode ? { right: 'in force' } : {}), primaryAction: 'select' as const };
      }),
      ...MCP_TOOL_RULES.map((rule) => ({ id: rule.id, label: rule.label, detail: rule.detail, primaryAction: 'select' as const })),
    ];
    this.open(server.name, items, `trust:${server.trustMode}`, (id) => {
      if (id.startsWith('trust:')) {
        const mode = id.slice('trust:'.length) as McpEntry['trustMode'];
        if (mode !== server.trustMode) void this.setTrust(server, mode);
        return;
      }
      const rule = MCP_TOOL_RULES.find((candidate) => candidate.id === id);
      if (rule) void this.toolRule(server, rule.capability);
    });
  }

  private async setTrust(server: McpEntry, mode: McpEntry['trustMode']): Promise<void> {
    if (mode === 'allow-all' && server.trustMode !== 'allow-all') {
      const asked = await this.options.host.confirm({
        title: `Stop holding ${server.name} to its limits?`,
        body: `Now ${server.name} ${mcpTrustWords(server.trustMode)}. After this every call it makes goes on as your permission mode allows, inside or outside its folders and sites.`,
        confirmLabel: 'Do not hold it to its limits',
      });
      if (!asked) { this.message = `Not changed: ${server.name} still ${mcpTrustWords(server.trustMode)}.`; this.redraw(); return; }
    }
    const outcome = await this.options.host.runCapability('mcp.trust', { server: server.name, mode });
    this.message = outcome.ok
      ? [`${server.name} now ${mcpTrustWords(mode)} (before, it ${mcpTrustWords(server.trustMode)}; choose that level again to put it back).`, ...outcome.lines].join(' ')
      : `Not changed: ${asSentence(outcome.reason)}`;
    this.readLocalLists();
    this.redraw();
  }

  private async toolRule(server: McpEntry, capability: string): Promise<void> {
    const values = await this.options.host.openForm(capability, { server: server.name }, { title: 'Settings', given: ['server'], display: { server: server.name } });
    if (!values) return;
    const outcome = await this.options.host.runCapability(capability, values);
    this.message = outcome.ok ? outcome.lines.join(' ') || 'Done.' : `Not changed: ${asSentence(outcome.reason)}`;
    this.readLocalLists();
    this.redraw();
  }

  /** Enter on an active sign-in signs out of it, for every program; how to sign in again is said. */
  private async signOut(entry: SubscriptionEntry): Promise<void> {
    if (entry.state !== 'active' && entry.state !== 'pending') {
      this.message = `${entry.provider} is not signed in: sign in in Models and providers.`;
      return;
    }
    const asked = await this.options.host.confirm({
      title: `Sign out of ${entry.provider}?`,
      body: `${entry.provider} is signed out for every program. It cannot be put back from here: only signing in again brings it back (Models and providers, Providers, ${entry.provider}).`,
      confirmLabel: 'Sign out',
    });
    if (!asked) { this.message = `Not signed out: ${entry.provider} stays ${entry.state === 'pending' ? 'as it is (its sign-in is still waiting to finish)' : 'signed in'}.`; this.redraw(); return; }
    const outcome = await this.options.host.runCapability('provider.sign-out', { provider: entry.provider });
    this.message = outcome.ok
      ? [...outcome.lines, `To sign in again: Models and providers, Providers, ${entry.provider}.`].join(' ')
      : `Not signed out: ${asSentence(outcome.reason)}`;
    this.readLocalLists();
    this.redraw();
  }

  // -- putting back ----------------------------------------------------------------

  /** The reset key: this setting, this topic or every setting; the wide two ask first. */
  private openReset(): void {
    if (this.editingMode || this.openList !== null) return;
    const entry = this.getSelected();
    const items: SelectionItem[] = [
      ...(entry && !entry.cards ? [{ id: 'setting', label: 'This setting', detail: `Put ${getSettingLabel(entry)} back to its default (${formatDefault(entry)}) now.` }] : []),
      ...(!this.searching ? [{ id: 'topic', label: 'This topic', detail: `Put every setting in ${this.topicLabel} back to its default. Asks before it does.` }] : []),
      { id: 'all', label: 'All settings', detail: `Put every setting${this.viewed !== this.own ? ` of ${programName(this.viewed)}` : ''} back to its default. Asks before it does.` },
    ];
    this.open('Reset to default', items, items[0]?.id, (id) => {
      if (id === 'setting' && entry) {
        const refused = this.refusal(entry);
        if (refused) { this.message = refused; return; }
        void this.write(this.targetOf(entry), RESET);
      } else if (id === 'topic') void this.resetMany(this.topicLabel, this.visibleRows().flatMap((row) => (row.kind === 'setting' ? [row.entry] : [])));
      else if (id === 'all') void this.resetMany('every topic', [...this.groups.values()].flat());
    });
  }

  private async resetMany(subject: string, entries: readonly ScreenEntry[]): Promise<void> {
    const seen = new Set<string>();
    const changed = entries.filter((entry) => {
      if (entry.cards || entry.isDefault || seen.has(entry.setting.key)) return false;
      seen.add(entry.setting.key);
      return this.refusal(entry) === undefined;
    });
    if (changed.length === 0) { this.message = `Every setting in ${subject} is already its default.`; return; }
    const asked = await this.options.host.confirm({
      title: `Put ${changed.length} setting${changed.length === 1 ? '' : 's'} back to the default?`,
      body: `Every setting in ${subject} that is not its default goes back to it: ${changed.slice(0, 6).map((entry) => getSettingLabel(entry)).join(', ')}${changed.length > 6 ? ', ...' : ''}. Each can be changed again afterwards.`,
      confirmLabel: 'Put them back',
    });
    if (!asked) { this.message = `Not changed: the settings in ${subject} stay as they are.`; this.redraw(); return; }
    const failed: string[] = [];
    let done = 0;
    for (const entry of changed) {
      const program = entry.owner === 'daemon' ? this.own : this.viewed;
      try {
        await runDaemonCapability('settings.reset', { key: entry.setting.key, program }, this.options.context as never, this.options.binding);
        done += 1;
      } catch (error) {
        failed.push(`${getSettingLabel(entry)} (${reasonOf(error)})`);
      }
    }
    this.message = `Put ${done} setting${done === 1 ? '' : 's'} back to the default.${failed.length > 0 ? ` Not put back, and kept as they were: ${failed.slice(0, 4).join('; ')}${failed.length > 4 ? '; ...' : ''}.` : ''}`;
    this.readValues();
    this.redraw();
  }

  // -- drawing -----------------------------------------------------------------

  /**
   * The help under the rows: the outcome of the last change first while it is fresh (until the selection moves), so
   * it takes the help's first line instead of a line of its own that would push the help out on a small screen.
   */
  helpLines(): HelpLine[] {
    const help = this.selectionHelp();
    if (!this.message) return help;
    // The first help line names the selected row, which the row itself shows (the documentation drops it); the outcome goes right after.
    return help.length > 0 ? [help[0]!, helpHeading(this.message), ...help.slice(1)] : [helpHeading(this.message)];
  }

  private selectionHelp(): HelpLine[] {
    if (this.searching) { const entry = this.getSelected(); return entry ? this.entryHelp(entry) : []; }
    switch (this.openList) {
      case 'mcp': return mcpHelp(this.selectedMcp(), programName(this.own));
      case 'subscriptions': return subscriptionHelp(this, this.selectedSubscription());
      case 'connections': return connectionHelp(this.selectedConnection());
      case 'flags': { const flag = this.selectedFeature(); return flag ? flagHelp(this, flag, this.entryOf(flag.feature.enablement.key) ?? null) : []; }
      case 'secure-address-now': {
        // The selected row's own words: what is served, why not, and each way's four parts, as the daemon gives them.
        const row = this.selectedSecureAddress();
        return row ? [helpText(row.label), ...(row.state ? [helpFact('State', row.state)] : []), ...row.detail.map((line) => helpText(line))] : [];
      }
      default: break;
    }
    const list = this.getSelectedListRow();
    if (list !== null) {
      const row = this.visibleRows().find((candidate) => candidate.kind === 'list' && candidate.list.category === list);
      return row?.kind === 'list' ? [helpText(row.list.label), helpText(asSentence(`Opens ${row.list.description}`))] : [];
    }
    const entry = this.getSelected();
    return entry ? this.entryHelp(entry) : [];
  }

  private entryHelp(entry: ScreenEntry): HelpLine[] {
    if (entry.flag) return flagHelp(this, entry.flag, entry);
    const lines = settingHelp(this, entry);
    if (RESTART_KEYS.has(entry.setting.key)) {
      lines.splice(1, 0, helpText('Takes effect when the daemon starts: changing it restarts the daemon by itself, after the change is answered (a daemon no service manager runs keeps the change for its next start, and says so).'));
    }
    const session = entry.setting.key === 'permissions.mode' ? this.sessionModeWords() : undefined;
    if (!session) return lines;
    return [...lines.slice(0, 1), helpText(`Shared default (every program): ${formatValue(entry)}. This hosted session: ${session}, set by the session that is running; changing this row changes the shared default, and the session keeps its own.`), ...lines.slice(1)];
  }

  /** The title of the section the open list belongs to ("Secure address"), drawn above it. */
  openListSection(): string | undefined {
    if (this.openList === null) return undefined;
    const row = this.topicRows.find((candidate) => candidate.kind === 'list' && candidate.list.category === this.openList);
    return row?.place.section;
  }

  /** The hosted session's own permission mode in words, when this program shows its own settings and runs one. */
  sessionModeWords(): string | undefined {
    if (this.viewed !== this.own) return undefined;
    const mode = this.options.program.sessionMode?.();
    return mode === undefined ? undefined : isGatePresetName(mode) ? gatePresetLabel(mode) : mode;
  }

  /** What the keys do now, each as bound. */
  hints(): KitHint[] {
    const enter = this.navLabel('choose', '⏎');
    const esc = this.navLabel('back', 'esc');
    const move = `${this.navLabel('move-up', '↑')}${this.navLabel('move-down', '↓')}`;
    const down = this.keyLabel(SETTINGS_KEYS.adjustDown, 'shift+←');
    const up = this.keyLabel(SETTINGS_KEYS.adjustUp, 'shift+→');
    const adjust = down.startsWith('shift+') && up.startsWith('shift+') ? `shift+${down.slice(6)}${up.slice(6)}` : `${down}/${up}`;
    const other = this.otherProgramKey;
    const otherName = programName(this.viewed === 'tui' ? 'agent' : 'tui');
    if (this.editingMode) return [[enter, 'save'], [esc, 'cancel']];
    if (!this.searching && this.focusRegion === 'categories') return [[move, 'topic'], [this.navLabel('move-right', '→'), 'its settings'], ['type', 'filter'], [other, otherName]];
    if (!this.searching && this.openList !== null) {
      const word = this.openList === 'mcp' ? 'trust and rules' : this.openList === 'subscriptions' ? 'sign out'
        : this.openList === 'flags' ? 'turn on or off' : this.openList === 'secure-address-now' ? (this.selectedSecureAddress()?.hint ?? '') : '';
      return [[move, 'move'], ...(word ? [[enter, word] as KitHint] : []), ...(this.openList === 'mcp' || this.openList === 'flags' ? [[adjust, 'adjust'] as KitHint] : []), [esc, 'back']];
    }
    const entry = this.getSelected();
    const onList = this.getSelectedListRow() !== null;
    const reset: KitHint[] = entry && !entry.cards ? [[this.keyLabel(SETTINGS_KEYS.reset, 'ctrl+r'), 'reset']] : [];
    const nudge: KitHint[] = entry && (entry.setting.type === 'number' || entry.setting.type === 'boolean' || (entry.setting.type === 'enum' && SETTINGS_CHOICE_ACTIONS[entry.setting.key] === undefined)) ? [[adjust, 'adjust']] : [];
    return [[move, 'move'], [enter, onList ? 'open' : 'change'], ...nudge, ...reset, [other, otherName], ...(this.searching ? [[esc, 'clear filter'] as KitHint] : [])];
  }

  /** The lines above the hints: the outcome of the last change, the program shown, and what could not be read or followed. */
  notices(): string[] {
    const lines: string[] = [];
    if (this.viewed !== this.own) lines.push(`${programName(this.viewed, true)}'s own settings; the daemon's are the same in every program. ${this.otherProgramKey} goes back to ${programName(this.own)}'s.`);
    if (this.values.kind === 'failed') lines.push(`The values could not be read: ${this.values.reason.replace(/[.\s]+$/, '')}. ${this.keyLabel(SETTINGS_KEYS.readAgain, 'ctrl+l')} reads them again; they are read by themselves when the daemon is back.`);
    else if (this.streamLost) lines.push(`Changes made elsewhere may not show yet (${this.streamLost}); they are read again by themselves when the daemon is back.`);
    // The outcome of a change is the help's first line (helpLines), not a line here.
    return lines;
  }

  breadcrumbs(): string[] {
    const whose = this.whoseSetting();
    if (this.searching) return [whose];
    const list = this.openList !== null ? this.topicRows.find((row) => row.kind === 'list' && row.list.category === this.openList) : undefined;
    return [whose, this.topicLabel, ...(list?.kind === 'list' ? [list.list.label] : [])];
  }

  /**
   * Whose the selected row is, as the heading names it: "For every program" for a setting the daemon keeps (and the
   * daemon's own lists: the secure address), else the program shown, by name.
   */
  private whoseSetting(): string {
    const daemon = 'For every program';
    if (this.openList === 'secure-address-now') return daemon;
    const onTopics = !this.searching && this.focusRegion === 'categories';
    const entry = onTopics || this.openList !== null ? null : this.getSelected();
    return entry && entry.owner === 'daemon' ? daemon : programName(this.viewed, true);
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return layout().renderSettingsModal(this, screenWidth, screenHeight);
  }
}

/** What each choice means for the program shown (help.ts), for the choice lists. */
function enumMeaningsOf(program: ScreenProgram): Readonly<Record<string, Readonly<Record<string, string>>>> {
  return enumDescriptionsFor(program);
}

// -- the drawing, built once -----------------------------------------------------------

let built: ReturnType<typeof buildLayout> | undefined;
function layout(): ReturnType<typeof buildLayout> {
  built ??= buildLayout();
  return built;
}

function buildLayout() {
  const { docLines, windowDoc } = createSettingsDocumentation<SettingsScreen>((screen) => screen.helpLines(), { clampStoredOffset: false, countIndicatorRow: false });
  const { listRows } = createSettingsRows<SettingsScreen, ScreenEntry, ScreenList>({
    label: getSettingLabel,
    color: valueColor,
    currentValue: (screen, entry, selected) => currentSettingValue(screen, entry, selected),
    unavailable: (entry) => !!entry.metadataUnavailable,
    visibleRows: (screen) => screen.visibleRows(),
    listCount: (screen, list) => screen.listCount(list),
    focused: (screen) => screen.searchFocused || screen.focusRegion === 'settings',
    routeLabel: (route) => route,
    listSection: (screen) => screen.openListSection(),
    specialRow(screen, entry, selected, focused, width) {
      // "When GoodVibes asks" with a hosted session's own mode: both labelled, given most of the line (the label is
      // shortened before the two values are).
      const session = entry.setting.key === 'permissions.mode' && !(selected && screen.editingMode) ? screen.sessionModeWords() : undefined;
      if (session) {
        const label = getSettingLabel(entry);
        const shared = currentSettingValue(screen, entry, selected);
        // The longest wording that leaves the label whole on the one line, else the shortest, clipped.
        const room = width - label.length - 4;
        const forms = [`shared: ${shared} · this session: ${session}`, `shared: ${shared} · session: ${session}`, `${shared} · session: ${session}`];
        const right = forms.find((form) => form.length <= room) ?? forms[forms.length - 1]!.slice(0, Math.max(8, room - 1)) + '…';
        return {
          label,
          right,
          rightFg: valueColor(entry),
          selected: selected && focused,
          current: selected && !focused,
        };
      }
      if (!entry.flag) return undefined;
      const t = activeTokens();
      const raw = currentSettingValue(screen, entry, selected);
      // A startup-gated feature changed this session says it waits for a restart.
      const value = entry.flag.pendingRestart ? `${raw} after a restart` : raw;
      return {
        label: entry.flag.feature.name,
        right: fitValue(value, width, selected && screen.editingMode, entry.flag.feature.name),
        rightFg: valueColor(entry),
        selected: selected && focused,
        current: selected && !focused,
        labelFg: entry.setting.key.startsWith('danger.') ? t.error : undefined,
      };
    },
    specialList(screen, _width, focused, clamp) {
      const rows = (items: readonly { readonly label: string; readonly right?: string | undefined; readonly rightFg?: string | undefined }[], empty: string): { rows: KitRow[]; selected: number } => {
        // The open list's section titled above it, as a topic's sections are.
        const section = screen.openListSection();
        // Section titles as written (their own capitals), not lower-cased by the list kit.
        const header: KitRow[] = section ? [{ header: section, headerAsWritten: true, selectable: false }] : [];
        if (items.length === 0) return { rows: [...header, { label: empty, muted: true }], selected: -1 };
        const at = clamp(items.length);
        return { rows: [...header, ...items.map((item, index) => ({ label: item.label, right: item.right, rightFg: item.rightFg, selected: focused && index === at, current: !focused && index === at }))], selected: at + header.length };
      };
      if (screen.openList === 'connections') {
        return rows(screen.connectionEntries.map((row) => ({ label: connectionLabel(row.surface), right: row.state === 'unreadable' ? 'could not be read' : row.state })), 'No connection is known to this build.');
      }
      if (screen.openList === 'secure-address-now') return rows(screen.secureAddressRows.map((row) => ({ label: row.label, right: row.state })), 'Nothing to show.');
      if (screen.openList === 'flags') {
        return rows(screen.featureEntries.map((flag) => ({ label: flag.feature.name, right: `${flag.state === 'enabled' ? 'On' : 'Off'}${flag.pendingRestart ? ' after a restart' : ''}`, rightFg: flagStateColor(flag.state) })), 'No features registered.');
      }
      return undefined;
    },
  });
  return createSettingsLayout<SettingsScreen>({
    listRows,
    topicRows: (screen) => settingsTopicRailRows({
      topics: screen.topics,
      topicIndex: screen.topicIndex,
      searching: screen.searchFocused,
      focused: !screen.searchFocused && screen.focusRegion === 'categories',
      onSelect: (index) => {
        if (screen.editingMode) return;
        screen.searchQuery = '';
        screen.searchResults = [];
        screen.selectTopic(index);
        screen.focusRegion = 'settings';
      },
    }),
    hints: (screen) => screen.hints(),
    docLines,
    windowDoc,
    notices: (screen) => screen.notices(),
    selectRow: (screen, index) => {
      screen.selectedIndex = index;
      screen.focusRegion = 'settings';
      screen.contextScroll = 0;
    },
    breadcrumbs: (screen) => screen.breadcrumbs(),
  });
}

import { hasActiveExecutionMode, readExecutionMode, setExecutionMode } from '../permissions/execution-mode.ts';
import { captureModelReadingInput } from '../tools/agent-harness-model-reading-source.ts';
import type { Ranked } from '@goodvibes-jev/judgment';
import type { ConfigManager, ConfigSetting } from '@goodvibes-jev/engine/platform/platform/config';
import { isAgentHostSettingKey } from '../config/host-settings.ts';
import { getAgentSettingsSchema, type AgentConfigSetting, type AgentHostReader, type AgentSettingsCatalog } from '../config/settings-catalog.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { applyWakeEnablementCompanion, type WakeCompanionWrite } from '../config/wake-enablement-companion.ts';
import type { SecretsManager } from '../config/secrets.ts';
import {
  buildGoodVibesSecretKey,
  defaultSecretBackedScope,
  isSecretConfigKey,
  isSecretReferenceValue,
  persistSecretBackedConfigValue,
} from '../config/secret-config.ts';
import { rankHarnessCatalog, captureCatalogData, type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { settingDomainForPhrase } from '../config/settings-search-vocabulary.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import {
  agentDaemonConfigClientInstalled,
  agentDaemonConfigClientRevision,
  configKeyScope,
  openEffectiveConfigView,
  routeConfigWrite,
  type AgentConfigRoutingOptions,
  type ConfigScope,
  type EffectiveConfigView,
} from '../config/daemon-config-routing.ts';

export interface HarnessSettingFilters {
  readonly key?: string;
  readonly category?: string;
  readonly prefix?: string;
  readonly query?: string;
  readonly includeHidden?: boolean;
  readonly limit?: number;
  /** The first matching row the page holds (0 when absent). */
  readonly offset?: number;
}

export type HarnessSettingLookupSource = 'key' | 'target' | 'query';
export type HarnessSettingResolvedBy = 'key' | 'case-insensitive-key' | 'search';

export interface HarnessSettingLookup {
  readonly source: HarnessSettingLookupSource;
  readonly input: string;
  readonly resolvedBy: HarnessSettingResolvedBy;
}

export interface HarnessSettingLookupArgs {
  readonly key?: string;
  readonly target?: string;
  readonly query?: string;
  readonly category?: string;
  readonly prefix?: string;
  readonly includeHidden?: boolean;
}

export interface HarnessSettingCandidate {
  readonly key: string;
  readonly category: string;
  readonly type: ConfigSetting['type'];
  readonly writable: boolean;
  readonly visibleInWorkspace: boolean;
  readonly modelRoute: string;
  readonly description: string;
}

export type HarnessSettingResolution =
  | {
    readonly status: 'found';
    readonly setting: HarnessSettingDescriptor;
    readonly lookup: HarnessSettingLookup;
  }
  | {
    readonly status: 'ambiguous';
    readonly input: string;
    readonly candidates: readonly HarnessSettingCandidate[];
  };

export interface HarnessSettingDescriptor {
  readonly judgment?: Ranked;
  readonly key: string;
  readonly category: string;
  readonly type: ConfigSetting['type'];
  readonly value: unknown;
  readonly default: unknown;
  readonly configured: boolean;
  readonly writable: boolean;
  readonly visibleInWorkspace: boolean;
  readonly modelRoute: string;
  readonly description: string;
  readonly enumValues?: readonly string[];
  readonly lookup?: HarnessSettingLookup;
  /** Which runtime owns this key: 'daemon' | 'client' | 'user'. */
  readonly scope?: ConfigScope;
  /** Which runtime answered the read: 'daemon' | 'local'. */
  readonly valueSource?: string;
  /** The file or daemon base URL the value came from. */
  readonly valueStore?: string;
  /**
   * True when the daemon owns this key and could not be reached, so its current
   * value is genuinely unknown. `value` is undefined and must NOT be presented
   * as the setting's value, the default would read as the current setting.
   */
  readonly valueUnavailable?: boolean;
  /** Host policy metadata could not be verified; editing is unavailable. */
  readonly metadataUnavailable?: string;
}

export interface HarnessSettingSummary {
  readonly judgment?: Ranked;
  readonly key: string;
  readonly category: string;
  readonly type: ConfigSetting['type'];
  readonly value: unknown;
  readonly configured: boolean;
  readonly writable: boolean;
  readonly visibleInWorkspace: boolean;
  readonly modelRoute: string;
  readonly summary: string;
  readonly enumValues?: readonly string[];
  /** Which runtime owns this key: 'daemon' | 'client' | 'user'. */
  readonly scope?: ConfigScope;
  /** Which runtime answered the read: 'daemon' | 'local'. */
  readonly valueSource?: string;
  /** The file or daemon base URL the value came from. */
  readonly valueStore?: string;
  /** True when the daemon owns this key and its current value is unknown. */
  readonly valueUnavailable?: boolean;
  readonly metadataUnavailable?: string;
}

export interface HarnessSettingMutationResult {
  readonly key: string;
  readonly action: 'set' | 'reset';
  readonly previous: unknown;
  readonly current: unknown;
  /** Which runtime owns the key: 'daemon' | 'client' | 'user'. */
  readonly scope?: ConfigScope | undefined;
  /** Which runtime actually applied it. */
  readonly appliedBy?: 'daemon' | 'local' | undefined;
  /**
   * The file (or daemon) the value landed in. Reported because "saved" is
   * ambiguous until the store is named: a daemon-owned value written into the
   * agent's own settings file configures nothing.
   */
  readonly persistedTo?: string | undefined;
  /** A second row that had to move with this one, see config/wake-enablement-companion.ts. */
  readonly alsoSet?: WakeCompanionWrite | undefined;
  /**
   * Set when the companion row could not be written after this key was. The
   * key itself IS changed; repeating the same set repairs the companion.
   */
  readonly alsoSetFailed?: string | undefined;
  /** Set when a reset setting's stored secret could not be deleted; the setting itself IS reset. */
  readonly secretNotDeleted?: string | undefined;
}

/**
 * Credential-looking LEAF names. Matched against the last dot segment only, and
 * never against the whole key, so an unrelated ancestor cannot drag a plain
 * value into redaction.
 */
const SENSITIVE_LEAF_PATTERN = /(?:secret|token|password|passphrase|api[-_.]?key|signing)/i;

/**
 * Identifier leaves that merely NAME a credential rather than being one.
 * `surfaces.telegram.discoveredBotTokenId` is the live example: it is the id of
 * a discovered bot, not the bot's token, and redacting it hid the result of the
 * bot-identity discovery from the person who asked for it. An `id` leaf that
 * also says secret/password is still treated as a secret.
 */
const IDENTIFIER_LEAF_PATTERN = /(?:id|ids|name|username|kind|type|mode|source)$/i;

function isSensitiveSettingKey(key: string): boolean {
  const leaf = key.split('.').pop() ?? key;
  if (!SENSITIVE_LEAF_PATTERN.test(leaf)) return false;
  if (/(?:secret|password|passphrase)/i.test(leaf)) return true;
  return !IDENTIFIER_LEAF_PATTERN.test(leaf);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function previewText(value: string, maxLength = 56): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

/**
 * The settings catalog is a fixed, enumerable set the caller is entitled to see
 * all of, not a feed, so there is no ceiling: a listing returns every match
 * unless the caller names a page size. A ceiling kept being overtaken by the
 * catalog and silently dropped its tail rows. Every caller states in words when
 * it returned fewer than matched.
 */
function pageSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.trunc(value));
}

function pageStart(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function findSetting(configManager: AgentSettingsCatalog, rawKey: string): AgentConfigSetting | null {
  if (!rawKey) return null;
  return getAgentSettingsSchema(configManager).find((setting) => setting.key === rawKey) ?? null;
}

function settingCandidate(setting: AgentConfigSetting): HarnessSettingCandidate {
  return {
    key: setting.key,
    category: setting.key.split('.')[0] ?? '',
    type: setting.type,
    // Every setting is writable through this surface now that the blanket
    // host-owned lock is gone. A write is decided at the settings tool by the
    // recorded admission for its exact effect, and a routed write reports the
    // store it landed in.
    writable: true,
    visibleInWorkspace: true,
    modelRoute: settingModelRoute(setting),
    description: setting.description,
  };
}

function settingLookupFromArgs(args: HarnessSettingLookupArgs): { source: HarnessSettingLookupSource; input: string } | null {
  const key = args.key?.trim();
  if (key) return { source: 'key', input: key };
  const target = args.target?.trim();
  if (target) return { source: 'target', input: target };
  const query = args.query?.trim();
  if (query) return { source: 'query', input: query };
  return null;
}

export function redactHarnessSettingValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value) return value;
  if (isSecretConfigKey(key) || isSensitiveSettingKey(key)) {
    if (isSecretReferenceValue(value)) return '<secret-ref>';
    return '<redacted>';
  }
  return value;
}

function settingModelRoute(setting: AgentConfigSetting): string {
  // There is no read-only route any more. It existed solely for the retired
  // blanket host-owned lock, and no key resolved to it once that lock's lists
  // were emptied.
  return `settings set|reset key:${setting.key}`;
}

/**
 * Resolve a setting's EFFECTIVE value and name the store it came from.
 *
 * With a view, a daemon-owned key reports the daemon's live value; without one
 * it falls back to the agent's own resolution (the pre-routing behavior, kept
 * so every existing call site still works). When the daemon owns the key and
 * could not be reached, `unavailable` is true and there is deliberately NO
 * value, reporting a default here is what told the owner his bot username was
 * not set when it was.
 */
function resolveSettingValue(
  configManager: Pick<ConfigManager, 'get'> & AgentHostReader,
  setting: AgentConfigSetting,
  view: EffectiveConfigView | undefined,
): { value: unknown; unavailable: boolean; source?: string; store?: string; writable?: boolean; metadataUnavailable?: string } {
  if (setting.kind === 'host') {
    const handle = configManager.getHostBooleanSetting?.(setting.key);
    if (!handle) return { value: undefined, unavailable: true, writable: false, metadataUnavailable: 'Host settings are unavailable.' };
    const value = handle.get();
    try {
      const resolved = handle.getResolved();
      return { value, unavailable: false, source: 'local', writable: resolved.managedLock === null };
    } catch (error) {
      return { value, unavailable: false, source: 'local', writable: false, metadataUnavailable: summarizeError(error) };
    }
  }
  if (!view) {
    return { value: configManager.get(setting.key), unavailable: false };
  }
  const entry = view.describe(setting.key);
  if (entry.status === 'unavailable') {
    return { value: undefined, unavailable: true, source: entry.source, store: entry.store };
  }
  return { value: entry.value, unavailable: false, source: entry.source, store: entry.store };
}

export function describeHarnessSetting(
  configManager: Pick<ConfigManager, 'get'> & AgentHostReader,
  setting: AgentConfigSetting,
  options: { readonly lookup?: HarnessSettingLookup; readonly view?: EffectiveConfigView } = {},
): HarnessSettingDescriptor {
  const resolved = resolveSettingValue(configManager, setting, options.view);
  return {
    key: setting.key,
    category: setting.key.split('.')[0] ?? '',
    type: setting.type,
    value: redactHarnessSettingValue(setting.key, resolved.value),
    default: redactHarnessSettingValue(setting.key, setting.default),
    configured: !resolved.unavailable && !valuesEqual(resolved.value, setting.default),
    writable: resolved.writable ?? true,
    visibleInWorkspace: true,
    modelRoute: settingModelRoute(setting),
    description: setting.description,
    scope: configKeyScope(setting.key),
    ...(resolved.source ? { valueSource: resolved.source } : {}),
    ...(resolved.store ? { valueStore: resolved.store } : {}),
    ...(resolved.unavailable ? { valueUnavailable: true } : {}),
    ...(resolved.metadataUnavailable ? { metadataUnavailable: resolved.metadataUnavailable } : {}),
    ...(setting.enumValues ? { enumValues: setting.enumValues } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };
}

export function describeHarnessSettingSummary(
  configManager: Pick<ConfigManager, 'get'> & AgentHostReader,
  setting: AgentConfigSetting,
  options: { readonly view?: EffectiveConfigView } = {},
): HarnessSettingSummary {
  const resolved = resolveSettingValue(configManager, setting, options.view);
  return {
    key: setting.key,
    category: setting.key.split('.')[0] ?? '',
    type: setting.type,
    value: redactHarnessSettingValue(setting.key, resolved.value),
    configured: !resolved.unavailable && !valuesEqual(resolved.value, setting.default),
    writable: resolved.writable ?? true,
    visibleInWorkspace: true,
    modelRoute: settingModelRoute(setting),
    summary: previewText(setting.description),
    scope: configKeyScope(setting.key),
    ...(resolved.source ? { valueSource: resolved.source } : {}),
    ...(resolved.store ? { valueStore: resolved.store } : {}),
    ...(resolved.unavailable ? { valueUnavailable: true } : {}),
    ...(resolved.metadataUnavailable ? { metadataUnavailable: resolved.metadataUnavailable } : {}),
    ...(setting.enumValues ? { enumValues: setting.enumValues } : {}),
  };
}

/**
 * The structural filters, key, category, prefix, hidden, with no search
 * applied. This is the catalog a caller asked to see, and the number every
 * page must report as its `total`.
 */
function harnessSettingCatalog(
  configManager: AgentSettingsCatalog,
  filters: HarnessSettingFilters = {},
): readonly AgentConfigSetting[] {
  return filterSettingCatalog(getAgentSettingsSchema(configManager), filters);
}

function filterSettingCatalog(schema: readonly AgentConfigSetting[], filters: HarnessSettingFilters) {
  const key = filters.key?.trim();
  const category = filters.category?.trim();
  const prefix = filters.prefix?.trim();
  return schema.filter((setting) => {
      if (key && setting.key !== key) return false;
      if (category && setting.key.split('.')[0] !== category) return false;
      if (prefix && !setting.key.startsWith(prefix)) return false;
      return true;
    });
}

export class SettingsSearchRequiresReadingError extends ToolInputProjectionError {
  constructor() {
    super('unavailable');
    this.message = 'Natural-language settings search requires the asynchronous protected settings reader.';
  }
}

/** Synchronous callers may enumerate structural filters, never interpret prose. */
function filterHarnessSettingSchema(configManager: AgentSettingsCatalog, filters: HarnessSettingFilters = {}): readonly AgentConfigSetting[] {
  if (filters.query?.trim()) throw new SettingsSearchRequiresReadingError();
  return harnessSettingCatalog(configManager, filters);
}

function captureSettingsReadingOptions(options: CatalogRankingOptions) {
  const { signal, assertCurrent } = options;
  const assertIdentity = () => { signal?.throwIfAborted(); };
  return { assertIdentity, assertCurrent: () => { assertIdentity(); assertCurrent?.(); } };
}

const settingSchemaUnchanged = (): void => {};

/**
 * The settings schema is replaced, never edited in place, so a caller knows it
 * is current by comparing the schema arrays' identity (every caller does);
 * nothing inside the program's own schema is re-checked per call. Kept so
 * callers can still retain a guard.
 */
export function bindSettingSchemaDescriptors(_roots: readonly unknown[]): () => void {
  return settingSchemaUnchanged;
}

/**
 * One immutable metadata snapshot for a prose search, with executable validators
 * bound separately. The schema is replaced, never edited in place, when it
 * changes, so whether it is still current is the identity of the two schema
 * arrays plus the configuration incarnation: three compares.
 */
function captureSettingCatalog(configManager: AgentSettingsCatalog, options: CatalogRankingOptions) {
  const caller = captureSettingsReadingOptions(options); caller.assertCurrent();
  const owner = configManager as AgentSettingsCatalog & Partial<Pick<ConfigManager, 'getConfigurationIncarnation'>>;
  const incarnation = owner.getConfigurationIncarnation?.();
  const builtin = configManager.getSchema(), hosts = configManager.getHostSettingsSchema?.();
  // Preserve hidden metadata for every registered Agent host row.
  const normalizedHosts: AgentConfigSetting[] = [];
  for (const host of hosts ?? []) {
    if (!isAgentHostSettingKey(host.key)) continue;
    const hostDescriptors = Object.getOwnPropertyDescriptors(host);
    if (hostDescriptors.kind && hostDescriptors.kind.value !== 'host') throw new ToolInputProjectionError('invalid');
    normalizedHosts.push(Object.defineProperties({}, {
      ...hostDescriptors, kind: { value: 'host', enumerable: true },
    }) as AgentConfigSetting);
  }
  const source: readonly AgentConfigSetting[] = [...builtin, ...normalizedHosts];
  const schema = Object.freeze(source.map(setting => {
    const { validate, ...data } = Object.getOwnPropertyDescriptors(setting);
    if (validate && (!('value' in validate) || (validate.value !== undefined && typeof validate.value !== 'function'))) throw new ToolInputProjectionError('invalid');
    return captureModelReadingInput(Object.defineProperties({}, data)) as AgentConfigSetting;
  }));
  const assertCurrent = () => {
    caller.assertIdentity();
    if (owner.getConfigurationIncarnation?.() !== incarnation
      || configManager.getSchema() !== builtin || configManager.getHostSettingsSchema?.() !== hosts) throw new ToolInputProjectionError('stale');
  };
  return { schema, assertCurrent };
}

type SettingCatalogSnapshot = ReturnType<typeof captureSettingCatalog>;

/** Every structurally eligible row reaches the existing canonical catalog reader. */
async function readHarnessSettingSchema(configManager: AgentSettingsCatalog, filters: HarnessSettingFilters,
  options: CatalogRankingOptions, captured: SettingCatalogSnapshot = captureSettingCatalog(configManager, options)) {
  const capturedFilters = captureModelReadingInput(filters);
  const assertCurrent = () => { options.assertCurrent?.(); captured.assertCurrent(); };
  // Registered for later consumers only after ranking, so the outer guard does
  // not run it again for every candidate the reading looks at.
  const retainSource = () => { options.retainCurrent?.(captured.assertCurrent); };
  const catalog = filterSettingCatalog(captured.schema, capturedFilters);
  const query = capturedFilters.query?.trim();
  if (!query) { retainSource(); return { matches: catalog.map(entry => ({ entry, judgment: undefined })), total: catalog.length, assertCurrent }; }
  // A search that is exactly one of a domain's plain phrases ("spending limit")
  // ranks only that domain's settings.
  const phraseDomain = settingDomainForPhrase(query);
  const inDomain = phraseDomain ? catalog.filter(setting => setting.key.split('.')[0] === phraseDomain) : [];
  const candidates = inDomain.length > 0 ? inDomain : catalog;
  const ranked = await rankHarnessCatalog(candidates, query, setting => ({
    id: setting.key,
    description: [setting.description, setting.type, ...(setting.enumValues ?? []), setting.validationHint ?? ''].join('\n'),
    evidence: setting,
  }), 'agent.harness.settings', { ...options, assertCurrent, requirePreservedSource: true });
  assertCurrent(); retainSource();
  return { ...ranked, total: catalog.length, assertCurrent };
}

/**
 * How many settings the caller's structural filters leave, ignoring `query`.
 *
 * This is what a page reports as `total`, and it is the number that was wrong:
 * the settings mode used to report the count of what MATCHED, so a query
 * nothing matched came back `{"settings": [], "returned": 0, "total": 0}` and
 * said the platform has no settings at all. Every other harness catalog already
 * reports its size here (`toolRegistry.getToolDefinitions().length`,
 * `allWorkspaceActions().length`), which is what makes the envelope's empty-page
 * sentence, "no settings matched X; N exist", possible to write.
 */
export function countHarnessSettingCatalog(
  configManager: AgentSettingsCatalog,
  filters: HarnessSettingFilters = {},
): number {
  return harnessSettingCatalog(configManager, filters).length;
}

export function listHarnessSettings(
  configManager: Pick<ConfigManager, 'get'> & AgentSettingsCatalog,
  filters: HarnessSettingFilters = {},
  options: { readonly includeParameters?: boolean; readonly view?: EffectiveConfigView } = {},
): readonly (HarnessSettingDescriptor | HarnessSettingSummary)[] {
  const start = pageStart(filters.offset);
  const limit = pageSize(filters.limit);
  const view = options.view;

  return filterHarnessSettingSchema(configManager, filters)
    .map((setting) => options.includeParameters
      ? describeHarnessSetting(configManager, setting, { ...(view ? { view } : {}) })
      : describeHarnessSettingSummary(configManager, setting, { ...(view ? { view } : {}) }))
    .slice(start, limit === undefined ? undefined : start + limit);
}

/**
 * The effective merged settings view: daemon-owned keys carry the DAEMON's live
 * value, everything else the agent's own, each entry naming the store it came
 * from. One daemon round-trip for the whole listing.
 *
 * This is the read counterpart of ownership-routed writes. Listing only the
 * agent's own store is what made the same key name read blank in one place and
 * set in another with nothing explaining why.
 */
export async function listEffectiveHarnessSettingsPage(
  configManager: ConfigManager,
  filters: HarnessSettingFilters = {},
  options: CatalogRankingOptions & { readonly includeParameters?: boolean; readonly routing?: AgentConfigRoutingOptions } = {},
): Promise<{ readonly settings: readonly (HarnessSettingDescriptor | HarnessSettingSummary)[]; readonly matched: number; readonly total: number }> {
  const caller = captureSettingsReadingOptions(options); caller.assertCurrent();
  const incarnation = configManager.getConfigurationIncarnation();
  const home = configManager.getHomeDirectory();
  const clientRevision = agentDaemonConfigClientRevision();
  const includeParameters = options.includeParameters;
  const routing = captureCatalogData(options.routing ?? {});
  const assertOwner = () => {
    caller.assertCurrent();
    if (configManager.getConfigurationIncarnation() !== incarnation || agentDaemonConfigClientRevision() !== clientRevision) throw new ToolInputProjectionError('stale');
  };
  const selected = await readHarnessSettingSchema(configManager, filters, { ...options, assertCurrent: assertOwner });
  selected.assertCurrent();
  const view = await openEffectiveConfigView(configManager, { homeDir: home ?? undefined, ...routing });
  selected.assertCurrent();
  const start = pageStart(filters.offset);
  const limit = pageSize(filters.limit);
  const settings = selected.matches.slice(start, limit === undefined ? undefined : start + limit).map(({ entry, judgment }) => ({
    ...(includeParameters ? describeHarnessSetting(configManager, entry, { view }) : describeHarnessSettingSummary(configManager, entry, { view })),
    ...(judgment ? { judgment } : {}),
  }));
  selected.assertCurrent();
  return { settings, matched: selected.matches.length, total: selected.total };
}

export async function listEffectiveHarnessSettings(
  configManager: ConfigManager,
  filters: HarnessSettingFilters = {},
  options: CatalogRankingOptions & { readonly includeParameters?: boolean; readonly routing?: AgentConfigRoutingOptions } = {},
): Promise<readonly (HarnessSettingDescriptor | HarnessSettingSummary)[]> {
  return (await listEffectiveHarnessSettingsPage(configManager, filters, options)).settings;
}

export function countHarnessSettings(
  configManager: AgentSettingsCatalog,
  filters: HarnessSettingFilters = {},
): number {
  return filterHarnessSettingSchema(configManager, filters).length;
}

export function getHarnessSetting(
  configManager: Pick<ConfigManager, 'get'> & AgentSettingsCatalog,
  key: string,
  lookup?: HarnessSettingLookup,
  view?: EffectiveConfigView,
): HarnessSettingDescriptor | null {
  const setting = findSetting(configManager, key);
  return setting ? describeHarnessSetting(configManager, setting, { lookup, ...(view ? { view } : {}) }) : null;
}

/**
 * Read one setting from whichever runtime OWNS it, the daemon for a
 * daemon-owned key, the agent's own store otherwise. The descriptor carries
 * `valueStore` (where the answer came from) and `valueUnavailable` (the daemon
 * owns it and could not be reached, so its value is unknown rather than
 * defaulted).
 */
export async function getEffectiveHarnessSetting(
  configManager: ConfigManager,
  key: string,
  options: { readonly lookup?: HarnessSettingLookup; readonly routing?: AgentConfigRoutingOptions } = {},
): Promise<HarnessSettingDescriptor | null> {
  const view = await openEffectiveConfigView(configManager, {
    homeDir: configManager.getHomeDirectory() ?? undefined,
    ...(options.routing ?? {}),
  });
  return getHarnessSetting(configManager, key, options.lookup, view);
}

function resolveHarnessSettingKey(
  configManager: Pick<ConfigManager, 'get'> & AgentSettingsCatalog,
  args: HarnessSettingLookupArgs,
  view?: EffectiveConfigView,
): HarnessSettingResolution | null {
  const lookup = settingLookupFromArgs(args);
  if (!lookup) return null;

  const exact = findSetting(configManager, lookup.input);
  if (exact) {
    const resolvedLookup = { ...lookup, resolvedBy: 'key' as const };
    return {
      status: 'found',
      setting: describeHarnessSetting(configManager, exact, { lookup: resolvedLookup, ...(view ? { view } : {}) }),
      lookup: resolvedLookup,
    };
  }

  const inputLower = lookup.input.toLowerCase();
  const schema = getAgentSettingsSchema(configManager);
  const caseInsensitiveMatches = schema.filter((setting) => setting.key.toLowerCase() === inputLower);
  if (caseInsensitiveMatches.length === 1) {
    const resolvedLookup = { ...lookup, resolvedBy: 'case-insensitive-key' as const };
    return {
      status: 'found',
      setting: describeHarnessSetting(configManager, caseInsensitiveMatches[0]!, { lookup: resolvedLookup, ...(view ? { view } : {}) }),
      lookup: resolvedLookup,
    };
  }
  if (caseInsensitiveMatches.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: caseInsensitiveMatches.map(settingCandidate).slice(0, 8),
    };
  }

  // Prose resolution is asynchronous and must carry a protected source lifetime.
  return null;
}

/** Exact identifiers remain synchronous; prose requires the async protected reader. */
export function resolveHarnessSetting(
  configManager: Pick<ConfigManager, 'get'> & AgentSettingsCatalog,
  args: HarnessSettingLookupArgs,
  view?: EffectiveConfigView,
): HarnessSettingResolution | null {
  const exact = resolveHarnessSettingKey(configManager, args, view);
  if (!exact && settingLookupFromArgs(args)) throw new SettingsSearchRequiresReadingError();
  return exact;
}

export async function resolveHarnessSettingAsync(
  configManager: Pick<ConfigManager, 'get'> & AgentSettingsCatalog,
  args: HarnessSettingLookupArgs,
  view?: EffectiveConfigView,
  options: CatalogRankingOptions = {},
): Promise<HarnessSettingResolution | null> {
  return resolveHarnessSettingReading(configManager, args, view, options);
}

async function resolveHarnessSettingReading(
  configManager: Pick<ConfigManager, 'get'> & AgentSettingsCatalog,
  args: HarnessSettingLookupArgs,
  view?: EffectiveConfigView,
  options: CatalogRankingOptions = {},
  captured?: SettingCatalogSnapshot,
): Promise<HarnessSettingResolution | null> {
  const caller = captureSettingsReadingOptions(options); caller.assertCurrent();
  const exact = resolveHarnessSettingKey(configManager, args, view);
  if (exact) return exact;
  const lookup = settingLookupFromArgs(args);
  if (!lookup) return null;
  const assertArgs = caller.assertCurrent;
  const selected = await readHarnessSettingSchema(configManager, {
    ...(args.category === undefined ? {} : { category: args.category }),
    ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
    includeHidden: args.includeHidden === true, query: lookup.input,
  }, { ...options, assertCurrent: assertArgs }, captured);
  selected.assertCurrent();
  const only = selected.matches.length === 1 ? selected.matches[0] : undefined;
  if (only?.judgment?.reading.verdict === 'yes' && only.judgment.reading.outcome === 'act') {
    const resolvedLookup = { ...lookup, resolvedBy: 'search' as const };
    const setting = { ...describeHarnessSetting(configManager, only.entry, { lookup: resolvedLookup, ...(view ? { view } : {}) }), judgment: only.judgment };
    selected.assertCurrent();
    return { status: 'found', setting, lookup: resolvedLookup };
  }
  return selected.matches.length ? { status: 'ambiguous', input: lookup.input,
    candidates: selected.matches.slice(0, 8).map(({ entry, judgment }) => ({ ...settingCandidate(entry), ...(judgment ? { judgment } : {}) })) } : null;
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  }
  throw new Error(`Expected boolean value, got ${String(value)}.`);
}

export function coerceHarnessSettingValue(setting: AgentConfigSetting, value: unknown): unknown {
  if (setting.kind === 'host') {
    if (typeof value !== 'boolean') throw new Error(`${setting.key} requires a literal boolean.`);
    return value;
  }
  if (setting.type === 'boolean') return coerceBoolean(value);
  if (setting.type === 'number') {
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(parsed)) throw new Error(`Expected numeric value for ${setting.key}.`);
    return parsed;
  }
  if (setting.type === 'enum') {
    const parsed = String(value).trim();
    if (!setting.enumValues?.includes(parsed)) {
      throw new Error(`Invalid value for ${setting.key}. Allowed: ${(setting.enumValues ?? []).join(', ')}.`);
    }
    return parsed;
  }
  return typeof value === 'string' ? value : String(value);
}

export async function setHarnessSetting(
  configManager: ConfigManager,
  secretsManager: Pick<SecretsManager, 'set' | 'delete'> | null | undefined,
  key: string,
  value: unknown,
  routing: AgentConfigRoutingOptions = {},
): Promise<HarnessSettingMutationResult> {
  const setting = findSetting(configManager, key);
  if (!setting) throw new Error(`Unknown setting ${key || '<missing>'}.`);
  if (setting.kind === 'host') {
    const handle = configManager.getHostBooleanSetting(setting.key);
    const previous = handle.get();
    const coerced = coerceHarnessSettingValue(setting, value);
    if (typeof coerced !== 'boolean') throw new Error(`${setting.key} requires a literal boolean.`);
    handle.getResolved();
    handle.set(coerced);
    return { key: setting.key, action: 'set', previous, current: handle.get(), scope: 'client', appliedBy: 'local' };
  }
  if (setting.key === 'permissions.mode') {
    const previous = readExecutionMode(configManager);
    const mode = coerceHarnessSettingValue(setting, value);
    await setExecutionMode(configManager, mode);
    return { key: setting.key, action: 'set', previous, current: readExecutionMode(configManager), ...executionModeDestination(configManager) };
  }
  const previous = configManager.getStored(setting.key);
  const coerced = coerceHarnessSettingValue(setting, value);
  if (setting.type === 'string' && isSecretConfigKey(setting.key)) {
    const secretValue = String(coerced);
    if (secretValue.trim() && !isSecretReferenceValue(secretValue) && !secretsManager?.set) {
      throw new Error(`Cannot store raw secret value for ${setting.key}: secrets manager is unavailable.`);
    }
    // No scope argument, deliberately, the same routing-by-ownership rule the
    // non-secret branch below applies. Every key that reaches here is in
    // SECRET_CONFIG_KEYS, and most of them (`surfaces.*` chat tokens,
    // `email.passwordRef`, the calendar client secrets) name a credential the
    // daemon executes with unattended. Pinning them to 'user' put the value
    // where the daemon cannot read it while the reference went to the daemon's
    // own settings file, so the setting reported success and changed nothing.
    const current = await persistSecretBackedConfigValue(
      configManager,
      secretsManager,
      setting.key,
      secretValue,
    );
    return {
      key: setting.key,
      action: 'set',
      previous: redactHarnessSettingValue(setting.key, previous),
      current: redactHarnessSettingValue(setting.key, current),
      ...secretBackedDestination(setting.key),
    };
  }

  // Route by OWNERSHIP, not by who asked. A daemon-owned key goes to the
  // daemon, that is where the runtime which acts on it reads from. An
  // agent-owned key goes to the agent's own store. The only failure case is the
  // daemon genuinely being unreachable, and routeConfigWrite throws rather than
  // writing locally and reporting a success that changed nothing.
  const outcome = await routeConfigWrite(configManager, setting.key, coerced, {
    homeDir: configManager.getHomeDirectory() ?? undefined,
    ...routing,
  });
  // A row that would otherwise configure nothing takes its companion with it.
  // The main value is already applied here. A companion failure (daemon
  // unreachable for a daemon-owned companion key) must not turn that into a
  // reported failure; say what did not move, and a repeat set repairs it.
  let companion: WakeCompanionWrite | null = null;
  let companionFailure: string | undefined;
  try {
    companion = await applyWakeEnablementCompanion(configManager, setting.key, coerced, routing);
  } catch (error) {
    companionFailure = `${setting.key} was set, but its companion row did not change: ${error instanceof Error ? error.message : String(error)} Re-run the same set to retry the companion.`;
  }

  return {
    key: setting.key,
    action: 'set',
    previous: redactHarnessSettingValue(setting.key, previous),
    current: redactHarnessSettingValue(setting.key, outcome.value),
    scope: outcome.scope,
    appliedBy: outcome.appliedBy,
    persistedTo: outcome.persistedTo,
    ...(companion ? { alsoSet: companion } : {}),
    ...(companionFailure ? { alsoSetFailed: companionFailure } : {}),
  };
}

export async function resetHarnessSetting(
  configManager: ConfigManager,
  secretsManager: Pick<SecretsManager, 'delete'> | null | undefined,
  key: string,
  routing: AgentConfigRoutingOptions = {},
): Promise<HarnessSettingMutationResult> {
  const setting = findSetting(configManager, key);
  if (!setting) throw new Error(`Unknown setting ${key || '<missing>'}.`);
  if (setting.key === 'permissions.mode') {
    const previous = readExecutionMode(configManager);
    await setExecutionMode(configManager, setting.default);
    return { key: setting.key, action: 'reset', previous, current: readExecutionMode(configManager), ...executionModeDestination(configManager) };
  }
  if (setting.kind === 'host') {
    const handle = configManager.getHostBooleanSetting(setting.key);
    const previous = handle.get();
    handle.getResolved();
    handle.reset();
    return { key: setting.key, action: 'reset', previous, current: handle.get() };
  }
  const previous = configManager.getStored(setting.key);
  const deletesSecret = isSecretConfigKey(setting.key);
  if (deletesSecret && typeof previous === 'string' && isSecretReferenceValue(previous) && !secretsManager?.delete) {
    throw new Error(`Cannot reset ${setting.key}: secrets manager is unavailable to delete the stored secret.`);
  }
  // The setting is reset first and the secret deleted only after that worked:
  // the other order leaves a setting pointing at a secret that no longer exists
  // whenever the reset fails (an unreachable daemon), and the channel stops
  // authenticating while the reset is reported as failed.
  // A daemon-owned key is reset where the daemon reads it, exactly as set
  // routes it: clearing the agent's local copy would report "reset" while the
  // daemon kept running on the old value. The schema default is written over
  // the owner's route, and an unreachable daemon throws rather than succeeding.
  let result: HarnessSettingMutationResult;
  if (configKeyScope(setting.key) === 'daemon') {
    const outcome = await routeConfigWrite(configManager, setting.key, setting.default, {
      homeDir: configManager.getHomeDirectory() ?? undefined,
      ...routing,
    });
    result = {
      key: setting.key,
      action: 'reset',
      previous: redactHarnessSettingValue(setting.key, previous),
      current: redactHarnessSettingValue(setting.key, outcome.value),
      scope: outcome.scope,
      appliedBy: outcome.appliedBy,
      persistedTo: outcome.persistedTo,
    };
  } else {
    configManager.reset(setting.key);
    result = {
      key: setting.key,
      action: 'reset',
      previous: redactHarnessSettingValue(setting.key, previous),
      current: redactHarnessSettingValue(setting.key, configManager.getStored(setting.key)),
      scope: configKeyScope(setting.key),
      appliedBy: 'local',
    };
  }
  if (deletesSecret) {
    // The scope the value was WRITTEN at, or the reset clears nothing: a
    // daemon-owned key's secret lives in the daemon tier, and deleting the
    // user-tier copy would report the setting reset while the live credential
    // stayed exactly where it was, a credential the operator believes is gone.
    const secretKey = buildGoodVibesSecretKey(setting.key);
    try {
      await secretsManager?.delete?.(secretKey, { scope: defaultSecretBackedScope(setting.key) });
    } catch {
      // Store errors may echo credential material, so none is included.
      return {
        ...result,
        secretNotDeleted: `${setting.key} was reset, but its stored secret ${secretKey} could not be deleted. Remove it with /secrets delete ${secretKey}.`,
      };
    }
  }
  return result;
}

/** Where a `permissions.mode` write landed: the hosted session that owns the mode, or this Agent's settings. */
function executionModeDestination(configManager: ConfigManager): Pick<HarnessSettingMutationResult, 'scope' | 'appliedBy' | 'persistedTo'> {
  return hasActiveExecutionMode(configManager)
    ? { scope: 'client', appliedBy: 'daemon', persistedTo: 'the hosted session on the connected host' }
    : { scope: 'client', appliedBy: 'local', persistedTo: 'this Agent\'s settings' };
}

/**
 * Where a secret-backed setting landed. A daemon-owned key goes to the daemon
 * when this process has a connected host wired; otherwise the reference stays in
 * this Agent's settings and the value in its secret store.
 */
function secretBackedDestination(key: Parameters<typeof defaultSecretBackedScope>[0]): Pick<HarnessSettingMutationResult, 'scope' | 'appliedBy' | 'persistedTo'> {
  const scope = configKeyScope(key);
  return scope === 'daemon' && agentDaemonConfigClientInstalled()
    ? { scope, appliedBy: 'daemon', persistedTo: 'the connected host\'s own settings and secret store' }
    : { scope, appliedBy: 'local', persistedTo: `this Agent's settings, with the value in its ${defaultSecretBackedScope(key)} secret store` };
}

/**
 * Prints a settings listing, and says so when the listing is short of the
 * settings that actually matched.
 *
 * The header used to read `Settings (500)` whether 500 was the whole answer or
 * the point at which the page stopped. A person reading that has no way to tell
 * a complete list from a cut-off one, so a missing key reads as a key that does
 * not exist. Pass `total`, what {@link countHarnessSettings} says matched, and
 * a short page names both numbers and how to widen it.
 */
export function formatHarnessSettingList(
  settings: readonly (HarnessSettingDescriptor | HarnessSettingSummary)[],
  total?: number,
): string {
  if (settings.length === 0) return 'No settings matched.';
  const shortOf = typeof total === 'number' && total > settings.length ? total : null;
  return [
    shortOf === null
      ? `Settings (${settings.length})`
      : `Settings (${settings.length} of ${shortOf}, this page is short; re-run with --limit ${shortOf} or narrow it with --category/--prefix)`,
    ...settings.map((setting) => {
      const status = setting.writable ? 'writable' : 'read-only';
      const visible = setting.visibleInWorkspace ? 'workspace' : 'scriptable';
      return `  ${setting.key}  ${setting.type}  ${status}/${visible}  current=${String(setting.value)}${setting.metadataUnavailable ? '  metadata unavailable; editing disabled' : ''}`;
    }),
  ].join('\n');
}

export function formatHarnessSetting(setting: HarnessSettingDescriptor | null): string {
  if (!setting) return 'Unknown setting.';
  return [
    `Setting ${setting.key}`,
    `  category ${setting.category}`,
    `  type ${setting.type}`,
    // An unknown value is printed as unknown. Printing the default here is what
    // reported a configured Telegram bot username as "not set".
    setting.valueUnavailable
      ? `  current UNKNOWN, ${setting.valueStore ?? 'the owning runtime'} could not be reached`
      : `  current ${String(setting.value)}`,
    `  default ${String(setting.default)}`,
    `  configured ${setting.valueUnavailable ? 'unknown' : (setting.configured ? 'yes' : 'no')}`,
    ...(setting.scope ? [`  owner ${setting.scope}`] : []),
    ...(setting.valueStore ? [`  store ${setting.valueStore}`] : []),
    `  writable ${setting.writable ? 'yes' : 'no'}`,
    ...(setting.metadataUnavailable ? [`  metadata unavailable: ${setting.metadataUnavailable}`] : []),
    `  workspace visible ${setting.visibleInWorkspace ? 'yes' : 'no'}`,
    ...(setting.enumValues ? [`  values ${setting.enumValues.join(', ')}`] : []),
    `  ${setting.description}`,
  ].join('\n');
}

export { formatHarnessMutation } from './harness-mutation-format.ts';

export function formatHarnessError(error: unknown): string {
  return summarizeError(error);
}

/**
 * Ownership-aware `resolveHarnessSetting`: a daemon-owned key resolves to the
 * DAEMON's live value, with the store named on the descriptor. The
 * synchronous overload above is kept for callers that have no daemon context.
 *
 * An exact or case-insensitive key is a plain schema lookup and returns at once;
 * the catalogue snapshot and its currency checks exist only for a prose search
 * that goes to the reading.
 */
export async function resolveEffectiveHarnessSetting(
  configManager: ConfigManager,
  args: HarnessSettingLookupArgs,
  routing: AgentConfigRoutingOptions = {},
  options: CatalogRankingOptions = {},
): Promise<HarnessSettingResolution | null> {
  const caller = captureSettingsReadingOptions(options); caller.assertCurrent();
  const lookup = settingLookupFromArgs(args);
  if (!lookup) return null;
  const incarnation = configManager.getConfigurationIncarnation();
  const home = configManager.getHomeDirectory();
  const clientRevision = agentDaemonConfigClientRevision();
  const capturedRouting = captureCatalogData(routing);
  const assertOwner = () => {
    caller.assertIdentity();
    if (configManager.getConfigurationIncarnation() !== incarnation || agentDaemonConfigClientRevision() !== clientRevision) throw new ToolInputProjectionError('stale');
  };
  const keyed = resolveHarnessSettingKey(configManager, args);
  const view = await openEffectiveConfigView(configManager, { homeDir: home ?? undefined, ...capturedRouting });
  if (keyed) {
    assertOwner();
    // Described again over the view so a daemon-owned key carries the daemon's value.
    return resolveHarnessSettingKey(configManager, args, view);
  }
  const captured = captureSettingCatalog(configManager, options);
  const retained: (() => void)[] = [];
  const assertCurrent = () => { caller.assertCurrent(); assertOwner(); captured.assertCurrent(); for (const guard of retained) guard(); };
  options.retainCurrent?.(assertOwner);
  assertCurrent();
  const selected = await resolveHarnessSettingReading(configManager, args, view, { ...options,
    assertCurrent: () => { caller.assertCurrent(); assertOwner(); },
    retainCurrent: (guard, key) => { retained.push(guard); options.retainCurrent?.(guard, key); },
  }, captured);
  assertCurrent(); options.retainCurrent?.(captured.assertCurrent);
  return selected;
}

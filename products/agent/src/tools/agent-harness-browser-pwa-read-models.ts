import { isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureCatalogProducerSources, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { readBrowserDeviceEvidence } from './agent-harness-browser-device-readings.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { redactedHarnessPreview } from './agent-harness-secret-redaction.ts';
import { types as nodeTypes } from 'node:util';

export interface BrowserPwaRecordCertification {
  readonly schemaStatus: 'certified' | 'legacy';
  readonly schemaVersion?: string;
  readonly publicationGuarantee?: string;
  readonly publisher?: string;
  readonly provenance?: readonly string[];
  readonly receiptId?: string;
  readonly cursor?: string;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface BrowserPwaCategoryRouteRecord {
  readonly provenance?: 'classic';
  readonly semanticAssessment?: 'not-evaluated' | 'partial';
  readonly id: string;
  readonly categoryId: string;
  readonly categoryIds: readonly string[];
  readonly laneId: string | null;
  readonly label: string | null;
  readonly status: string;
  readonly summary: string | null;
  readonly route: string;
  readonly url: string | null;
  readonly mobileReady: boolean | null;
  readonly pwaReady: boolean | null;
  readonly capabilities: readonly string[];
  readonly controlRoutes: Readonly<Record<string, string>>;
  readonly modelRoute: string;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'platform-read-model';
  readonly certification: BrowserPwaRecordCertification;
}

export interface BrowserPwaFirstRunReceiptRecord {
  readonly provenance?: 'classic';
  readonly semanticAssessment?: 'not-evaluated' | 'partial';
  readonly id: string;
  readonly status: string;
  readonly summary: string | null;
  readonly url: string | null;
  readonly manifestStatus: string | null;
  readonly serviceWorkerStatus: string | null;
  readonly installStatus: string | null;
  readonly offlineStatus: string | null;
  readonly capabilities: readonly string[];
  readonly controlRoutes: Readonly<Record<string, string>>;
  readonly modelRoute: string;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'platform-read-model';
  readonly certification: BrowserPwaRecordCertification;
}

export interface BrowserPwaReadModelSnapshot {
  readonly provenance?: 'classic';
  readonly semanticAssessment?: 'not-evaluated' | 'partial';
  readonly categoryRoutes: readonly BrowserPwaCategoryRouteRecord[];
  readonly firstRunReceipts: readonly BrowserPwaFirstRunReceiptRecord[];
  readonly sourceCounts: Readonly<Record<string, number>>;
  /** Producers that threw or answered asynchronously; their records are NOT in this snapshot. */
  readonly sourceErrors?: readonly string[];
}

interface SourceCandidate {
  readonly path: string;
  readonly source: unknown;
  readonly kind: 'daemon-read-model' | 'platform-read-model';
}

interface CollectedRecord {
  readonly path: string;
  readonly kind: 'daemon-read-model' | 'platform-read-model';
  readonly record: Record<string, unknown>;
}

const CATEGORY_WRAPPER_KEYS = [
  'records',
  'items',
  'categoryRoutes',
  'workspaceRoutes',
  'agentWorkspaceRoutes',
  'browserRoutes',
  'mobileRoutes',
  'surfaces',
  'lanes',
  'categories',
] as const;

const RECEIPT_WRAPPER_KEYS = [
  'records',
  'items',
  'receipts',
  'firstRunReceipts',
  'runtimeReceipts',
  'completionReceipts',
  'pwaReceipts',
  'events',
  'eventStream',
] as const;

const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'toJSON'] as const;
const CATEGORY_METHODS = ['listCategoryRoutes', 'listWorkspaceRoutes', 'listAgentWorkspaceRoutes', 'listRoutes', 'list'] as const;
const RECEIPT_METHODS = ['listFirstRunReceipts', 'listReceipts', 'listRuntimeReceipts', 'listEvents', 'list'] as const;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return readObject(record.metadata);
}

function nestedString(record: Record<string, unknown>, key: string): string {
  return readString(record[key])
    || readString(readMetadata(record)[key])
    || readString(readObject(record.route)[key])
    || readString(readObject(record.workspace)[key])
    || readString(readObject(record.category)[key])
    || readString(readObject(record.lane)[key])
    || readString(readObject(record.pwa)[key])
    || readString(readObject(record.browser)[key])
    || readString(readObject(record.evidence)[key])
    || readString(readObject(record.receipt)[key]);
}

function certificationRecords(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  return [
    record,
    readMetadata(record),
    readObject(record.schema),
    readObject(record.contract),
    readObject(record.publication),
    readObject(record.receipt),
    readObject(record.certification),
  ];
}

function firstAcross(records: readonly Record<string, unknown>[], keys: readonly string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return '';
}

function stringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 80);
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 80) : [];
}

function safePreview(value: string, limit: number): string {
  return redactedHarnessPreview(value, limit);
}

function safeNullablePreview(value: string, limit: number): string | null {
  return value ? safePreview(value, limit) : null;
}

function safeUrl(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    // Credentials and fragments can carry secrets; neither is needed to identify the page.
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|authorization|credential|api[-_]?key/i.test(key)) url.searchParams.set(key, '<redacted>');
    }
    return previewHarnessText(url.toString(), 180);
  } catch {
    return safeNullablePreview(value, 180);
  }
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function readyStatus(value: string): boolean {
  const status = normalizeToken(value);
  return [
    'ready',
    'published',
    'complete',
    'completed',
    'ok',
    'success',
    'succeeded',
    'active',
    'installed',
    'registered',
    'available',
    'usable',
    'online',
    'healthy',
    'browser-native-ready',
    'mobile-ready',
    'pwa-ready',
  ].includes(status);
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const token = normalizeToken(value);
    if (['true', 'yes', '1', 'ready', 'available', 'enabled', 'mobile-ready', 'pwa-ready', 'responsive'].includes(token)) return true;
    if (['false', 'no', '0', 'missing', 'disabled', 'not-ready', 'setup-needed', 'blocked'].includes(token)) return false;
  }
  return null;
}

function certificationBase(record: Record<string, unknown>, sourcePath: string): {
  readonly records: readonly Record<string, unknown>[];
  readonly schemaStatus: BrowserPwaRecordCertification['schemaStatus'];
  readonly schemaVersion: string;
  readonly publicationGuarantee: string;
  readonly publisher: string;
  readonly receiptId: string;
  readonly cursor: string;
  readonly provenance: readonly string[];
} {
  const records = certificationRecords(record);
  const explicit = firstAcross(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']).toLowerCase().replace(/[_\s]+/g, '-');
  const schemaStatus = ['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)
    || (
      firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'])
      && firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'browserPwaPublicationGuarantee', 'routePublicationGuarantee', 'firstRunPublicationGuarantee'])
      && firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId'])
    )
    ? 'certified'
    : 'legacy';
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'browserPwaPublicationGuarantee', 'routePublicationGuarantee', 'firstRunPublicationGuarantee']);
  const publisher = firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const receiptId = firstAcross(records, ['receiptId', 'routeReceiptId', 'categoryRouteReceiptId', 'firstRunReceiptId', 'durableReceiptId', 'eventId']);
  const cursor = firstAcross(records, ['cursor', 'freshnessCursor', 'eventCursor', 'sequence', 'checkpoint', 'streamCursor']);
  const provenance = [...new Set([
    ...stringArray(record.provenance),
    sourcePath ? `source ${sourcePath}` : '',
    firstAcross(records, ['methodId']) ? `method ${firstAcross(records, ['methodId'])}` : '',
    firstAcross(records, ['actionId']) ? `action ${firstAcross(records, ['actionId'])}` : '',
    firstAcross(records, ['sourceTool']) ? `sourceTool ${firstAcross(records, ['sourceTool'])}` : '',
  ].map((entry) => safePreview(entry, 180)).filter(Boolean))].slice(0, 8);
  return {
    records,
    schemaStatus,
    schemaVersion,
    publicationGuarantee,
    publisher,
    receiptId,
    cursor,
    provenance,
  };
}

function certification(input: {
  readonly record: Record<string, unknown>;
  readonly sourcePath: string;
  readonly kind: 'browser-native workspace category route' | 'browser/PWA first-run receipt';
  readonly durableId: string;
  readonly status: string;
  readonly modelRoute: string;
  readonly hasRoute: boolean;
  readonly hasCategories?: boolean;
  readonly hasMobileEvidence?: boolean | null;
  readonly hasPwaEvidence?: boolean | null;
  /** Names of PWA runtime statuses the record published with a value that is not a ready one. */
  readonly pwaNotReady?: readonly string[];
}): BrowserPwaRecordCertification {
  const base = certificationBase(input.record, input.sourcePath);
  const missingSignals = [
    ...(base.schemaStatus === 'certified' ? [] : [`Certified ${input.kind} schema is not published.`]),
    ...(input.durableId ? [] : [`Durable ${input.kind} id is not published.`]),
    ...(input.status ? [] : [`${input.kind} status is not published.`]),
    ...(readyStatus(input.status) ? [] : [`${input.kind} status is not ready.`]),
    ...(base.publicationGuarantee ? [] : [`${input.kind} publication guarantee is not published.`]),
    ...(base.publisher ? [] : [`${input.kind} publisher is not published.`]),
    ...(base.provenance.length > 0 ? [] : [`${input.kind} provenance is not published.`]),
    ...(base.cursor ? [] : [`${input.kind} freshness cursor is not published.`]),
    ...(input.modelRoute && input.hasRoute ? [] : [`Exact ${input.kind} inspect/open route is not published.`]),
    ...(input.hasCategories === false ? ['Browser-native Agent workspace category ids are not published.'] : []),
    ...(input.hasMobileEvidence === null ? ['Mobile/touch readiness was not evaluated during Classic operation; publish an explicit readiness field.'] : []),
    ...(input.hasPwaEvidence === null ? ['PWA readiness was not evaluated during Classic operation; publish explicit runtime status fields.'] : []),
    ...(input.hasMobileEvidence === false ? ['Mobile/touch control evidence is not published for this browser-native route.'] : []),
    ...(input.hasPwaEvidence === false ? ['PWA runtime evidence such as manifest, service-worker, install, or offline status is not published.'] : []),
    ...(input.pwaNotReady ?? []).map((name) => `PWA ${name} status is published but not ready.`),
  ];
  return {
    schemaStatus: base.schemaStatus,
    ...(base.schemaVersion ? { schemaVersion: safePreview(base.schemaVersion, 80) } : {}),
    ...(base.publicationGuarantee ? { publicationGuarantee: safePreview(base.publicationGuarantee, 220) } : {}),
    ...(base.publisher ? { publisher: safePreview(base.publisher, 80) } : {}),
    ...(base.provenance.length > 0 ? { provenance: base.provenance } : {}),
    ...(base.receiptId ? { receiptId: safePreview(base.receiptId, 96) } : {}),
    ...(base.cursor ? { cursor: safePreview(base.cursor, 96) } : {}),
    missingSignals,
    policy: 'Browser/PWA read models certify release readiness only when the platform or daemon publishes schema, durable ids, ready status, publication guarantee, publisher/provenance, freshness cursor, exact inspect/open routes, mobile/touch evidence, PWA runtime evidence where relevant, and redacted receipt metadata.',
  };
}

function callMethod(source: Record<string, unknown>, method: string, path: string, problems: string[]): unknown {
  const fn = source[method];
  if (typeof fn !== 'function') return undefined;
  try {
    const value = (fn as () => unknown).call(source);
    if (nodeTypes.isPromise(value) || (value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function')) {
      // Swallow a later rejection; the producer is reported, not awaited.
      void Promise.resolve(value).catch(() => {});
      problems.push(`${path}.${method}() answered asynchronously, so its records were not read`);
      return undefined;
    }
    return value;
  } catch (error) {
    problems.push(error instanceof ToolInputProjectionError
      ? `${path}.${method}() was refused by the source guard (an asynchronous or non-plain answer is not read), so its records are missing`
      : `${path}.${method}() threw: ${safePreview(error instanceof Error ? error.message : String(error), 120)}`);
    return undefined;
  }
}

function collectFromSource(
  source: unknown,
  path: string,
  kind: 'daemon-read-model' | 'platform-read-model',
  wrapperKeys: readonly string[],
  methods: readonly string[],
  problems: string[],
  visited = new WeakSet<object>(),
): readonly CollectedRecord[] {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source.flatMap((entry, index) => collectFromSource(entry, `${path}[${index}]`, kind, wrapperKeys, methods, problems, visited));
  }
  if (source instanceof Map) {
    return Array.from(source.entries()).flatMap(([key, value]) => collectFromSource(value, `${path}.${String(key)}`, kind, wrapperKeys, methods, problems, visited));
  }
  if (typeof source !== 'object') return [];
  if (visited.has(source)) return [];
  visited.add(source);
  const record = source as Record<string, unknown>;
  const problemsBefore = problems.length;
  const fromSnapshots = SNAPSHOT_METHODS.flatMap((method) => {
    const snapshot = callMethod(record, method, path, problems);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, wrapperKeys, methods, problems, visited);
  });
  const fromMethods = methods.flatMap((method) => {
    const snapshot = callMethod(record, method, path, problems);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, wrapperKeys, methods, problems, visited);
  });
  const fromWrappers = wrapperKeys.flatMap((key) => {
    if (!(key in record)) return [];
    return collectFromSource(record[key], `${path}.${key}`, kind, wrapperKeys, methods, problems, visited);
  });
  if (fromSnapshots.length > 0 || fromMethods.length > 0 || fromWrappers.length > 0) {
    return [...fromSnapshots, ...fromMethods, ...fromWrappers];
  }
  // A producer that failed or answered asynchronously is reported, not read as a record
  // describing itself (its methods would make the whole snapshot invalid).
  if (problems.length > problemsBefore) return [];
  return [{ path, kind, record }];
}

function routeMap(record: Record<string, unknown>): Readonly<Record<string, string>> {
  const routes = { ...readObject(record.routes), ...readObject(record.controls) };
  const output: Record<string, string> = {};
  for (const key of ['inspect', 'open', 'chat', 'setup', 'approve', 'approvals', 'automations', 'memory', 'channels', 'install', 'manifest', 'serviceWorker', 'offline', 'finish']) {
    const value = readString(routes[key]) || nestedString(record, `${key}Route`);
    if (value) output[key] = safePreview(value, 180);
  }
  return output;
}

function routeForRecord(record: Record<string, unknown>, routes: Readonly<Record<string, string>>): string {
  return nestedString(record, 'browserRoute')
    || nestedString(record, 'openRoute')
    || nestedString(record, 'route')
    || routes.open
    || routes.inspect
    || '';
}

function modelRoute(record: Record<string, unknown>, fallback: string): string {
  return nestedString(record, 'modelRoute')
    || nestedString(record, 'inspectRoute')
    || nestedString(record, 'browserRoute')
    || nestedString(record, 'openRoute')
    || nestedString(record, 'route')
    || fallback;
}

function capabilityTokens(record: Record<string, unknown>): readonly string[] {
  return [...new Set([
    ...stringArray(record.capabilities),
    ...stringArray(record.features),
    ...stringArray(readObject(record.pwa).capabilities),
    ...stringArray(readObject(record.browser).capabilities),
    ...stringArray(readObject(record.evidence).capabilities),
  ].map((entry) => safePreview(entry, 80)).filter(Boolean))].slice(0, 24);
}

/** The category ids a record published, with no position-based stand-in. */
function publishedCategoryIds(record: Record<string, unknown>): readonly string[] {
  const ids = [
    ...stringArray(record.categoryIds),
    ...stringArray(readObject(record.route).categoryIds),
    ...stringArray(readObject(record.workspace).categoryIds),
    nestedString(record, 'categoryId'),
    nestedString(record, 'workspaceCategoryId'),
  ].map((entry) => safePreview(entry, 80)).filter(Boolean);
  return [...new Set(ids)].slice(0, 80);
}

async function evidenceBoolean(record: Record<string, unknown>, keys: readonly string[],
  kind: 'mobile-touch' | 'pwa-runtime', options: CatalogRankingOptions): Promise<boolean | null> {
  if (isClassicOperation()) return readBrowserDeviceEvidence({ kind, record }, options);
  for (const key of keys) {
    const value = readBoolean(record[key])
      ?? readBoolean(readMetadata(record)[key])
      ?? readBoolean(readObject(record.pwa)[key])
      ?? readBoolean(readObject(record.browser)[key])
      ?? readBoolean(readObject(record.evidence)[key]);
    if (value !== null) return value;
  }
  return readBrowserDeviceEvidence({ kind, record }, options);
}

async function normalizeCategoryRoute(entry: CollectedRecord, index: number, options: CatalogRankingOptions): Promise<BrowserPwaCategoryRouteRecord | null> {
  const beganClassic = isClassicOperation();
  const publishedIds = publishedCategoryIds(entry.record);
  const ids = publishedIds.length > 0 ? publishedIds : [`browser-category-${index}`];
  const categoryId = ids[0] ?? `browser-category-${index}`;
  const publishedId = nestedString(entry.record, 'id')
    || nestedString(entry.record, 'routeId')
    || nestedString(entry.record, 'receiptId');
  const id = safePreview(publishedId || `browser-category-route:${categoryId}:${index}`, 120);
  const routes = routeMap(entry.record);
  const route = routeForRecord(entry.record, routes);
  const status = safePreview(nestedString(entry.record, 'status') || nestedString(entry.record, 'state') || 'unknown', 80);
  const routeForModel = safePreview(modelRoute(entry.record, `computer action:"browser" categoryId:"${categoryId}" includeParameters:true`), 240);
  const capabilities = capabilityTokens(entry.record);
  const mobileReady = await evidenceBoolean(entry.record, ['mobileReady', 'touchReady', 'responsive', 'mobileStatus'], 'mobile-touch', options);
  options.assertCurrent?.();
  const pwaReady = await evidenceBoolean(entry.record, ['pwaReady', 'installReady', 'offlineReady', 'pwaStatus'], 'pwa-runtime', options);
  options.assertCurrent?.();
  return {
    ...(isClassicOperation() ? { provenance: 'classic' as const, semanticAssessment: beganClassic ? 'not-evaluated' as const : 'partial' as const } : {}),
    id,
    categoryId,
    categoryIds: ids,
    laneId: safeNullablePreview(nestedString(entry.record, 'laneId'), 80),
    label: safeNullablePreview(nestedString(entry.record, 'label') || nestedString(entry.record, 'title'), 120),
    status,
    summary: safeNullablePreview(nestedString(entry.record, 'summary') || nestedString(entry.record, 'detail'), 220),
    route: route ? safePreview(route, 180) : routeForModel,
    url: safeUrl(nestedString(entry.record, 'url') || nestedString(entry.record, 'browserUrl')),
    mobileReady,
    pwaReady,
    capabilities,
    controlRoutes: routes,
    modelRoute: routeForModel,
    sourcePath: entry.path,
    source: entry.kind,
    certification: certification({
      record: entry.record,
      sourcePath: entry.path,
      kind: 'browser-native workspace category route',
      durableId: publishedId,
      status,
      modelRoute: routeForModel,
      hasRoute: Boolean(route || Object.keys(routes).length > 0),
      hasCategories: publishedIds.length > 0,
      hasMobileEvidence: mobileReady,
    }),
  };
}

async function normalizeFirstRunReceipt(entry: CollectedRecord, index: number, options: CatalogRankingOptions): Promise<BrowserPwaFirstRunReceiptRecord | null> {
  const beganClassic = isClassicOperation();
  const publishedId = nestedString(entry.record, 'id')
    || nestedString(entry.record, 'receiptId')
    || nestedString(entry.record, 'firstRunReceiptId')
    || nestedString(entry.record, 'durableReceiptId')
    || nestedString(entry.record, 'eventId');
  const id = safePreview(publishedId || `browser-pwa-first-run:${index}`, 120);
  const routes = routeMap(entry.record);
  const status = safePreview(nestedString(entry.record, 'status')
    || nestedString(entry.record, 'state')
    || nestedString(entry.record, 'receiptStatus')
    || nestedString(entry.record, 'result')
    || nestedString(entry.record, 'outcome')
    || 'unknown', 80);
  const publishedRoute = modelRoute(entry.record, '');
  const routeForModel = safePreview(publishedRoute || 'computer action:"browser" includeParameters:true', 240);
  const capabilities = capabilityTokens(entry.record);
  const manifestStatus = safeNullablePreview(nestedString(entry.record, 'manifestStatus'), 80);
  const serviceWorkerStatus = safeNullablePreview(nestedString(entry.record, 'serviceWorkerStatus'), 80);
  const installStatus = safeNullablePreview(nestedString(entry.record, 'installStatus'), 80);
  const offlineStatus = safeNullablePreview(nestedString(entry.record, 'offlineStatus'), 80);
  // A status string is evidence only when it says ready; "missing" or "failed"
  // is a published statement that the capability does not work.
  const pwaStatuses: readonly (readonly [string, string | null])[] = [
    ['manifest', manifestStatus], ['service worker', serviceWorkerStatus], ['install', installStatus], ['offline', offlineStatus],
  ];
  const published = pwaStatuses.filter((entryStatus): entryStatus is readonly [string, string] => entryStatus[1] !== null);
  const pwaNotReady = published.filter(([, value]) => !readyStatus(value)).map(([name]) => name);
  const hasPwaEvidence = published.some(([, value]) => readyStatus(value)) ? true
    : published.length > 0 ? undefined
    : await evidenceBoolean(entry.record, ['pwaReady', 'manifestReady', 'serviceWorkerReady', 'offlineReady', 'installReady'], 'pwa-runtime', options);
  options.assertCurrent?.();
  return {
    ...(isClassicOperation() ? { provenance: 'classic' as const, semanticAssessment: beganClassic ? 'not-evaluated' as const : 'partial' as const } : {}),
    id,
    status,
    summary: safeNullablePreview(nestedString(entry.record, 'summary') || nestedString(entry.record, 'detail'), 220),
    url: safeUrl(nestedString(entry.record, 'url') || nestedString(entry.record, 'browserUrl') || nestedString(entry.record, 'pwaUrl')),
    manifestStatus,
    serviceWorkerStatus,
    installStatus,
    offlineStatus,
    capabilities,
    controlRoutes: routes,
    modelRoute: routeForModel,
    sourcePath: entry.path,
    source: entry.kind,
    certification: certification({
      record: entry.record,
      sourcePath: entry.path,
      kind: 'browser/PWA first-run receipt',
      durableId: publishedId,
      status,
      modelRoute: routeForModel,
      hasRoute: Boolean(Object.keys(routes).length > 0 || publishedRoute),
      ...(hasPwaEvidence === undefined ? {} : { hasPwaEvidence }),
      pwaNotReady,
    }),
  };
}

function dedupeById<T extends { readonly id: string }>(records: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    output.push(record);
  }
  return output;
}

function sourceCounts(entries: readonly CollectedRecord[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.path] = (counts[entry.path] ?? 0) + 1;
  return counts;
}

function categorySources(native: ReturnType<typeof captureCatalogProducerSources>): readonly SourceCandidate[] {
  return [
    { path: 'context.platform.readModels.browserPwa.categoryRoutes', source: native.source('context.platform.readModels.browserPwa.categoryRoutes'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwa.workspaceRoutes', source: native.source('context.platform.readModels.browserPwa.workspaceRoutes'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwa.agentWorkspaceRoutes', source: native.source('context.platform.readModels.browserPwa.agentWorkspaceRoutes'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.webDashboard.categoryRoutes', source: native.source('context.platform.readModels.webDashboard.categoryRoutes'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.webDashboard.workspaceRoutes', source: native.source('context.platform.readModels.webDashboard.workspaceRoutes'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserCockpit.categoryRoutes', source: native.source('context.platform.readModels.browserCockpit.categoryRoutes'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.pwa.workspaceRoutes', source: native.source('context.platform.readModels.pwa.workspaceRoutes'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browser.categoryRoutes', source: native.source('context.platform.readModels.browser.categoryRoutes'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwaRoutes', source: native.source('context.platform.readModels.browserPwaRoutes'), kind: 'daemon-read-model' },
    { path: 'context.ops.browserPwa.categoryRoutes', source: native.source('context.ops.browserPwa.categoryRoutes'), kind: 'platform-read-model' },
    { path: 'context.clients.operator.browserPwa.categoryRoutes', source: native.source('context.clients.operator.browserPwa.categoryRoutes'), kind: 'platform-read-model' },
    { path: 'context.clients.operatorApiClient.browserPwa.categoryRoutes', source: native.source('context.clients.operatorApiClient.browserPwa.categoryRoutes'), kind: 'platform-read-model' },
  ];
}

function receiptSources(native: ReturnType<typeof captureCatalogProducerSources>): readonly SourceCandidate[] {
  return [
    { path: 'context.platform.readModels.browserPwa.firstRunReceipts', source: native.source('context.platform.readModels.browserPwa.firstRunReceipts'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwa.receipts', source: native.source('context.platform.readModels.browserPwa.receipts'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwa.runtimeReceipts', source: native.source('context.platform.readModels.browserPwa.runtimeReceipts'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.webDashboard.firstRunReceipts', source: native.source('context.platform.readModels.webDashboard.firstRunReceipts'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserCockpit.firstRunReceipts', source: native.source('context.platform.readModels.browserCockpit.firstRunReceipts'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.pwa.firstRunReceipts', source: native.source('context.platform.readModels.pwa.firstRunReceipts'), kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.firstRun.browserPwaReceipts', source: native.source('context.platform.readModels.firstRun.browserPwaReceipts'), kind: 'daemon-read-model' },
    { path: 'context.ops.browserPwa.firstRunReceipts', source: native.source('context.ops.browserPwa.firstRunReceipts'), kind: 'platform-read-model' },
    { path: 'context.clients.operator.browserPwa.firstRunReceipts', source: native.source('context.clients.operator.browserPwa.firstRunReceipts'), kind: 'platform-read-model' },
    { path: 'context.clients.operatorApiClient.browserPwa.firstRunReceipts', source: native.source('context.clients.operatorApiClient.browserPwa.firstRunReceipts'), kind: 'platform-read-model' },
  ];
}

export function isCertifiedBrowserPwaCategoryRoute(record: BrowserPwaCategoryRouteRecord): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0;
}

export function isCertifiedBrowserPwaFirstRunReceipt(record: BrowserPwaFirstRunReceiptRecord): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0;
}

export function browserPwaRouteCoversCategory(record: BrowserPwaCategoryRouteRecord, categoryId: string): boolean {
  const expected = categoryId.toLowerCase();
  return record.categoryIds.some((id) => {
    const value = id.toLowerCase();
    return value === expected || value === '*' || value === 'all' || value === 'agent-workspace';
  });
}

export function certifiedBrowserPwaCategoryRouteForCategory(
  snapshot: BrowserPwaReadModelSnapshot,
  categoryId: string,
): BrowserPwaCategoryRouteRecord | null {
  return snapshot.categoryRoutes.find((record) => isCertifiedBrowserPwaCategoryRoute(record) && browserPwaRouteCoversCategory(record, categoryId)) ?? null;
}

export function certifiedBrowserPwaFirstRunReceipts(
  snapshot: BrowserPwaReadModelSnapshot,
): readonly BrowserPwaFirstRunReceiptRecord[] {
  return snapshot.firstRunReceipts.filter(isCertifiedBrowserPwaFirstRunReceipt);
}

export async function browserPwaReadModelSnapshot(context: CommandContext,
  options: CatalogRankingOptions = {}): Promise<BrowserPwaReadModelSnapshot> {
  return withConfiguredDecisionModelPolicy(() => ownedBrowserPwaReadModelSnapshot(context, options));
}

async function ownedBrowserPwaReadModelSnapshot(context: CommandContext, options: CatalogRankingOptions): Promise<BrowserPwaReadModelSnapshot> {
  const beganClassic = isClassicOperation();
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const native = captureCatalogProducerSources(context, ["context.platform.readModels.browserPwa.categoryRoutes", "context.platform.readModels.browserPwa.workspaceRoutes", "context.platform.readModels.browserPwa.agentWorkspaceRoutes", "context.platform.readModels.webDashboard.categoryRoutes", "context.platform.readModels.webDashboard.workspaceRoutes", "context.platform.readModels.browserCockpit.categoryRoutes", "context.platform.readModels.pwa.workspaceRoutes", "context.platform.readModels.browser.categoryRoutes", "context.platform.readModels.browserPwaRoutes", "context.ops.browserPwa.categoryRoutes", "context.clients.operator.browserPwa.categoryRoutes", "context.clients.operatorApiClient.browserPwa.categoryRoutes", "context.platform.readModels.browserPwa.firstRunReceipts", "context.platform.readModels.browserPwa.receipts", "context.platform.readModels.browserPwa.runtimeReceipts", "context.platform.readModels.webDashboard.firstRunReceipts", "context.platform.readModels.browserCockpit.firstRunReceipts", "context.platform.readModels.pwa.firstRunReceipts", "context.platform.readModels.firstRun.browserPwaReceipts", "context.ops.browserPwa.firstRunReceipts", "context.clients.operator.browserPwa.firstRunReceipts", "context.clients.operatorApiClient.browserPwa.firstRunReceipts"], ["getSnapshot", "snapshot", "toJSON", "listCategoryRoutes", "listWorkspaceRoutes", "listAgentWorkspaceRoutes", "listRoutes", "listFirstRunReceipts", "listReceipts", "listRuntimeReceipts", "listEvents", "list"]);
  const problems: string[] = [];
  const categoryEntries = categorySources(native).flatMap((candidate) =>
    collectFromSource(candidate.source, candidate.path, candidate.kind, CATEGORY_WRAPPER_KEYS, CATEGORY_METHODS, problems)
  );
  const receiptEntries = receiptSources(native).flatMap((candidate) =>
    collectFromSource(candidate.source, candidate.path, candidate.kind, RECEIPT_WRAPPER_KEYS, RECEIPT_METHODS, problems)
  );
  const caller = captureAsyncHarnessInput({ categoryEntries, receiptEntries, problems, producerSource: native.evidence() }, options);
  caller.options.retainCurrent(native.assertCurrent, 'agent.browser.native-source');
  caller.retainSourceCurrent();
  return withModelReadingSource(caller.args, caller.options, async (captured, current) => {
    const categoryRoutes: BrowserPwaCategoryRouteRecord[] = [];
    for (const [index, entry] of captured.categoryEntries.entries()) {
      const record = await normalizeCategoryRoute(entry, index, current);
      current.assertCurrent?.();
      if (record) categoryRoutes.push(record);
    }
    const firstRunReceipts: BrowserPwaFirstRunReceiptRecord[] = [];
    for (const [index, entry] of captured.receiptEntries.entries()) {
      const record = await normalizeFirstRunReceipt(entry, index, current);
      current.assertCurrent?.();
      if (record) firstRunReceipts.push(record);
    }
    const result = {
      ...(isClassicOperation() ? { provenance: 'classic' as const, semanticAssessment: beganClassic ? 'not-evaluated' as const : 'partial' as const } : {}),
      categoryRoutes: dedupeById(categoryRoutes), firstRunReceipts: dedupeById(firstRunReceipts),
      sourceCounts: { ...sourceCounts(captured.categoryEntries), ...sourceCounts(captured.receiptEntries) },
      ...(captured.problems.length > 0 ? { sourceErrors: captured.problems } : {}),
    };
    current.assertCurrent?.();
    return result;
  });
}

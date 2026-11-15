import type { DaemonSystemRouteHandlers } from './context.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  isJsonRecord,
  readBoundedBodyInteger,
  readOptionalStringField,
  type JsonRecord,
} from './route-helpers.js';
import { jsonErrorResponse, readJsonErrorResponse } from './error-response.js';
import { withAdmin } from './auth-helpers.js';
import type {
  ApprovalRememberTier,
  AutomationDeliveryGuarantee,
  AutomationRouteBindingKind,
  AutomationSessionPolicy,
  AutomationSurfaceKind,
  AutomationThreadPolicy,
  DaemonSystemRouteContext,
  WatcherKind,
} from './system-route-types.js';
import { APPROVAL_REMEMBER_TIERS } from './system-route-types.js';

const WATCHER_KIND_VALUES: readonly WatcherKind[] = ['filesystem', 'webhook', 'socket', 'integration', 'polling'];
const WATCHER_SOURCE_KIND_MAP: Readonly<Record<string, WatcherKind>> = {
  webhook: 'webhook',
  file: 'filesystem',
  stream: 'socket',
  api: 'integration',
};
const WATCHER_SOURCE_RECORD_KIND_MAP: Readonly<Record<string, 'webhook' | 'hook' | 'watcher'>> = {
  webhook: 'webhook',
  file: 'hook',
  stream: 'hook',
  api: 'hook',
};
const CUSTOM_RUN_METADATA_KEY = 'customRun';
const DEFAULT_WATCHER_INTERVAL_MS = 60_000;
const MIN_WATCHER_INTERVAL_MS = 1_000;
const MAX_WATCHER_INTERVAL_MS = 86_400_000;

interface RouteBindingCreateBody {
  readonly surfaceKind: AutomationSurfaceKind;
  readonly kind: AutomationRouteBindingKind;
  readonly surfaceId: string;
  readonly externalId: string;
}

const systemBodySchemas = createRouteBodySchemaRegistry({
  routeBindingCreate: createRouteBodySchema<RouteBindingCreateBody>('POST /api/system/route-bindings', (body) => {
    const surfaceKind = readOptionalStringField(body, 'surfaceKind');
    const kind = readOptionalStringField(body, 'kind');
    const surfaceId = readOptionalStringField(body, 'surfaceId');
    const externalId = readOptionalStringField(body, 'externalId');
    if (!surfaceKind || !kind || !surfaceId || !externalId) {
      return jsonErrorResponse({ error: 'Missing required route binding fields' }, { status: 400 });
    }
    return {
      surfaceKind: surfaceKind as AutomationSurfaceKind,
      kind: kind as AutomationRouteBindingKind,
      surfaceId,
      externalId,
    };
  }),
});

export function createDaemonSystemRouteHandlers(
  context: DaemonSystemRouteContext,
): DaemonSystemRouteHandlers {
  return {
    getWatchers: () => Response.json({ watchers: context.watcherRegistry.list() }),
    postWatcher: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleRegisterWatcher(context, req);
    },
    patchWatcher: (watcherId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleUpdateWatcher(context, watcherId, req);
    },
    watcherAction: (watcherId, action, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleWatcherAction(context, watcherId, action, req);
    },
    deleteWatcher: (watcherId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const removed = context.watcherRegistry.removeWatcher(watcherId);
      return removed
        ? Response.json({ removed: true, id: watcherId })
        : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
    },
    // Admin only: the status carries the installed unit file, which can hold the
    // operator token, and install/start/stop beside it are admin only too.
    getServiceStatus: (req?: Request) => {
      // A caller that cannot pass the request cannot be checked, so it never
      // receives the unit file.
      const admin = req ? context.requireAdmin(req) : null;
      if (admin) return admin;
      const full = context.platformServiceManager.status();
      const { contents: _unitFile, ...withoutUnitFile } = full;
      return Response.json({
        ...(req ? full : withoutUnitFile),
        network: {
          controlPlane: context.inspectInboundTls('controlPlane'),
          httpListener: context.inspectInboundTls('httpListener'),
          outbound: context.inspectOutboundTls(),
        },
      });
    },
    installService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.install());
    },
    startService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.start());
    },
    stopService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.stop());
    },
    restartService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.restart());
    },
    uninstallService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.uninstall());
    },
    getRouteBindings: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json({ bindings: context.routeBindings.listBindings() });
    },
    postRouteBinding: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = systemBodySchemas.routeBindingCreate.parse(body);
      if (input instanceof Response) return input;
      const binding = await context.routeBindings.upsertBinding({
        id: typeof body.id === 'string' ? body.id : undefined,
        kind: input.kind,
        surfaceKind: input.surfaceKind,
        surfaceId: input.surfaceId,
        externalId: input.externalId,
        sessionPolicy: typeof body.sessionPolicy === 'string' ? body.sessionPolicy as AutomationSessionPolicy : undefined,
        threadPolicy: typeof body.threadPolicy === 'string' ? body.threadPolicy as AutomationThreadPolicy : undefined,
        deliveryGuarantee: typeof body.deliveryGuarantee === 'string' ? body.deliveryGuarantee as AutomationDeliveryGuarantee : undefined,
        threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
        channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
        runId: typeof body.runId === 'string' ? body.runId : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      });
      return Response.json(binding, { status: 201 });
    },
    patchRouteBinding: async (bindingId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const updated = await context.routeBindings.patchBinding(bindingId, {
        ...(body.sessionPolicy !== undefined ? { sessionPolicy: typeof body.sessionPolicy === 'string' ? body.sessionPolicy as AutomationSessionPolicy : undefined } : {}),
        ...(body.threadPolicy !== undefined ? { threadPolicy: typeof body.threadPolicy === 'string' ? body.threadPolicy as AutomationThreadPolicy : undefined } : {}),
        ...(body.deliveryGuarantee !== undefined ? { deliveryGuarantee: typeof body.deliveryGuarantee === 'string' ? body.deliveryGuarantee as AutomationDeliveryGuarantee : undefined } : {}),
        ...(body.threadId !== undefined ? { threadId: typeof body.threadId === 'string' ? body.threadId : undefined } : {}),
        ...(body.channelId !== undefined ? { channelId: typeof body.channelId === 'string' ? body.channelId : undefined } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId === null ? null : typeof body.sessionId === 'string' ? body.sessionId : undefined } : {}),
        ...(body.jobId !== undefined ? { jobId: body.jobId === null ? null : typeof body.jobId === 'string' ? body.jobId : undefined } : {}),
        ...(body.runId !== undefined ? { runId: body.runId === null ? null : typeof body.runId === 'string' ? body.runId : undefined } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      });
      return updated
        ? Response.json(updated)
        : jsonErrorResponse({ error: 'Unknown route binding' }, { status: 404 });
    },
    deleteRouteBinding: async (bindingId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const removed = await context.routeBindings.removeBinding(bindingId);
      return removed
        ? Response.json({ removed: true, id: bindingId })
        : jsonErrorResponse({ error: 'Unknown route binding' }, { status: 404 });
    },
    getApprovals: (url?: URL) => {
      if (!context.integrationHelpers) {
        return jsonErrorResponse({ error: 'Integration helper service unavailable' }, { status: 503 });
      }
      const approvalId = url?.searchParams.get('approvalId')?.trim();
      return Response.json(context.integrationHelpers.getApprovalSnapshot(approvalId || undefined));
    },
    // A decision grants or withholds tool execution (and can persist a durable
    // rule), so it takes the same authority as the other state changes here.
    // Shared and paired-device tokens are admin; only a non-admin user session is refused.
    approvalAction: (approvalId, action, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleApprovalAction(context, approvalId, action, req);
    },
    getConfig: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(redactSecretConfigValues(context, context.configManager.getAll()));
    },
    getCredentials: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      if (!context.credentialStatus) {
        // Honest degraded state: no shared secret store is wired, so we cannot
        // truthfully report credential status. Never fabricate an empty "no
        // credentials" answer that a caller would read as "nothing configured".
        return jsonErrorResponse(
          { error: 'Shared credential store unavailable', code: 'CREDENTIAL_STORE_UNAVAILABLE' },
          { status: 503 },
        );
      }
      const key = new URL(req.url).searchParams.get('key');
      if (key !== null) {
        const trimmed = key.trim();
        if (!trimmed) {
          return jsonErrorResponse({ error: 'Missing or invalid key' }, { status: 400 });
        }
        const record = await context.credentialStatus.get(trimmed);
        return Response.json({ available: true, credentials: record ? [record] : [] });
      }
      const credentials = await context.credentialStatus.list();
      return Response.json({ available: true, credentials });
    },
    postConfig: async (req) => {
      const requestLifetime = context.settingsPrecondition?.lifetime() ?? null;
      const importLifetime = context.settingsImportPrecondition?.lifetime() ?? null;
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const payload = await context.parseJsonBody(req);
      if (payload instanceof Response) return payload;
      // Body parsing yields. Reacquire current admin before either effect path.
      const currentAdmin = context.requireAdmin(req);
      if (currentAdmin) return currentAdmin;
      if (Object.hasOwn(payload, 'settingsImportPrecondition')) {
        return context.settingsImportPrecondition?.handle(req, payload, importLifetime)
          ?? jsonErrorResponse({ error: 'Settings import owner unavailable', code: 'SETTINGS_IMPORT_PRECONDITION_UNSUPPORTED' }, { status: 409 });
      }
      if (Object.hasOwn(payload, 'settingsPrecondition')) {
        return context.settingsPrecondition?.handle(req, payload, requestLifetime)
          ?? jsonErrorResponse({ error: 'Settings owner precondition unavailable', code: 'SETTINGS_PRECONDITION_UNSUPPORTED' }, { status: 409 });
      }
      const { key, value } = payload;
      if (!key || typeof key !== 'string') {
        return jsonErrorResponse({ error: 'Missing or invalid key' }, { status: 400 });
      }
      if (key === 'runtime.workingDir') {
        return handleWorkingDirectoryConfig(context, key, value);
      }
      if (!context.isValidConfigKey(key)) {
        return jsonErrorResponse({ error: 'Invalid config key' }, { status: 400 });
      }
      // A credential never goes into a config file as a literal. The settings
      // precondition lane files it in the secret store and leaves a reference;
      // a value that already is such a reference is safe to write here.
      if (context.isSecretBearingConfigKey?.(key) && !isSecretReference(value)) {
        return jsonErrorResponse(
          {
            error: `Config key ${key} holds a credential and cannot be written as plain text. Nothing was changed. `
              + 'Write it through the settings precondition (capture, then apply), which stores it in the secret store, '
              + 'or pass a goodvibes://secrets/ reference.',
            code: 'SECRET_CONFIG_KEY',
          },
          { status: 400 },
        );
      }
      try {
        context.configManager.setDynamic(key, value);
      } catch (error: unknown) {
        return readJsonErrorResponse(error, { status: 400, fallbackMessage: 'Failed to set config' });
      }
      // Report what the host now HOLDS, not what the caller asked for.
      //
      // Echoing the request back made this route say "success" for any write,
      // it could not distinguish a value that took from one that was coerced,
      // dropped, or overridden. It also never named the store, and the store is
      // the whole question here: an agent writes over the control plane into the
      // DAEMON's surface-scoped settings file, then reads the same key back from
      // its OWN settings file and sees the old value. Both are correct; nothing
      // said they were different files.
      const current = context.configManager.get(key);
      const source = context.configManager.describeConfigKeySource?.(key);
      // A daemon-owned key does NOT live in the host's surface settings file,
      // it lives in the daemon's own store. Reporting the surface path for it
      // would name the wrong file, which is the confusion this replaces.
      const persistedTo = (source?.daemonOwned ? source.daemonTierPath : null)
        ?? context.configManager.getConfigPath?.();
      if (!configValuesMatch(current, value) && !configValuesMatch(current, normalizeRequested(context, key, value))) {
        return jsonErrorResponse(
          {
            error: `Config key ${key} did not take the requested value`
              + `${persistedTo ? ` in ${persistedTo}` : ''}.`
              + `${context.isSecretBearingConfigKey?.(key) ? '' : ` The host now reports ${JSON.stringify(current)}.`}`,
            code: 'CONFIG_SET_NOT_APPLIED',
          },
          { status: 409 },
        );
      }
      // Name the OWNER as well as the file. "Saved" is only meaningful once a
      // caller knows whether the value landed where the runtime that acts on it
      // will read it, the whole point of daemon-owned config scope.
      return Response.json({
        success: true,
        key,
        value: current,
        ...(persistedTo ? { persistedTo } : {}),
        ...(source ? { tier: source.tier, daemonOwned: source.daemonOwned,
          ...(source.effectiveOrigin ? { effectiveOrigin: source.effectiveOrigin } : {}) } : {}),
      });
    },
    postConfigReset: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const payload = await context.parseJsonBody(req);
      if (payload instanceof Response) return payload;
      // Body parsing yields. Reacquire current admin before the write.
      const currentAdmin = context.requireAdmin(req);
      if (currentAdmin) return currentAdmin;
      const { key } = payload;
      if (!key || typeof key !== 'string') {
        return jsonErrorResponse({ error: 'Missing or invalid key' }, { status: 400 });
      }
      if (key === 'runtime.workingDir' || !context.isValidConfigKey(key)) {
        return jsonErrorResponse({ error: 'Invalid config key' }, { status: 400 });
      }
      // Resetting would leave the stored secret behind with nothing pointing at it.
      if (context.isSecretBearingConfigKey?.(key)) {
        return jsonErrorResponse(
          {
            error: `Config key ${key} holds a credential. Nothing was changed. Remove it with credentials.delete, which clears the stored secret and then the reference.`,
            code: 'SECRET_CONFIG_KEY',
          },
          { status: 400 },
        );
      }
      if (!context.configManager.reset) {
        return jsonErrorResponse({ error: 'This host cannot reset a setting. Nothing was changed.', code: 'CONFIG_RESET_UNSUPPORTED' }, { status: 409 });
      }
      try {
        context.configManager.reset(key);
      } catch (error: unknown) {
        return readJsonErrorResponse(error, { status: 400, fallbackMessage: 'Failed to reset config' });
      }
      const source = context.configManager.describeConfigKeySource?.(key);
      const persistedTo = (source?.daemonOwned ? source.daemonTierPath : null) ?? context.configManager.getConfigPath?.();
      return Response.json({
        success: true,
        key,
        value: context.configManager.get(key),
        ...(persistedTo ? { persistedTo } : {}),
        ...(source ? { tier: source.tier, daemonOwned: source.daemonOwned,
          ...(source.effectiveOrigin ? { effectiveOrigin: source.effectiveOrigin } : {}) } : {}),
      });
    },
  };
}

/**
 * A watcher's request headers are stored with the watcher and returned by the
 * watcher routes, so a header that carries a credential must be a
 * `goodvibes://secrets/` reference, which the registry resolves when it makes
 * the request. A literal value is refused before anything is stored.
 */
function refuseLiteralWatcherHeaders(body: Record<string, unknown>): Response | null {
  const metadata = isJsonRecord(body.metadata) ? body.metadata : {};
  const sourceMetadata = isJsonRecord(body.source) && isJsonRecord(body.source.metadata) ? body.source.metadata : {};
  const literal = new Set<string>();
  for (const headers of [body.headers, metadata.headers, sourceMetadata.headers]) {
    if (!isJsonRecord(headers)) continue;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string' && !isSecretReference(value)) literal.add(name);
    }
  }
  if (literal.size === 0) return null;
  return jsonErrorResponse(
    {
      error: `Watcher header${literal.size > 1 ? 's' : ''} ${[...literal].join(', ')} would be stored as plain text. Nothing was changed. `
        + 'Store the value in the secret store and pass a goodvibes://secrets/ reference as the header value.',
      code: 'WATCHER_HEADER_LITERAL',
    },
    { status: 400 },
  );
}

async function handleRegisterWatcher(context: DaemonSystemRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const literalHeaders = refuseLiteralWatcherHeaders(body);
  if (literalHeaders) return literalHeaders;
  const label = typeof body.label === 'string' && body.label.trim().length > 0 ? body.label.trim() : '';
  const id = typeof body.id === 'string' && body.id.trim().length > 0
    ? body.id.trim()
    : label
      ? ((): string => {
          const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          // If the label consists entirely of special chars the slug will be empty.
          return slug ? `watcher-${slug}` : `watcher-${Date.now()}`;
        })()
      : `watcher-${Date.now()}`;
  const kind = readWatcherKind(body.kind, body.sourceKind, 'polling');
  const intervalMs = readWatcherIntervalMs(body.intervalMs, context.configManager.get('watchers.pollIntervalMs'));
  if (!label) {
    return jsonErrorResponse({ error: 'Missing watcher label' }, { status: 400 });
  }
  const metadata = typeof body.metadata === 'object' && body.metadata !== null
    ? body.metadata as Record<string, unknown>
    : {};
  const sourceMetadata = {
    ...metadata,
    ...(typeof body.url === 'string' ? { url: body.url } : {}),
    ...(typeof body.method === 'string' ? { method: body.method.toUpperCase() } : {}),
    ...(typeof body.path === 'string' ? { path: body.path } : {}),
    ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
    ...(typeof body.address === 'string' ? { address: body.address } : {}),
    ...(typeof body.headers === 'object' && body.headers !== null ? { headers: body.headers } : {}),
  };
  // Registering is an upsert, so a repeat would silently replace the first watcher.
  if (context.watcherRegistry.getWatcher(id)) {
    return jsonErrorResponse(
      { error: `Watcher ${id} already exists. PATCH it to change it, or choose a different label or id.`, code: 'WATCHER_EXISTS' },
      { status: 409 },
    );
  }
  const record = context.watcherRegistry.registerWatcher({
    id,
    label,
    kind,
    source: {
      id: typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : `source:${id}`,
      kind: typeof body.sourceKind === 'string'
        ? WATCHER_SOURCE_RECORD_KIND_MAP[body.sourceKind] ?? 'watcher'
        : 'watcher',
      label,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: sourceMetadata,
    },
    intervalMs,
    // The run text is kept in the metadata so a later PATCH can carry it over.
    metadata: typeof body.run === 'string' ? { ...sourceMetadata, [CUSTOM_RUN_METADATA_KEY]: body.run } : sourceMetadata,
    ...(typeof body.run === 'string' ? { run: () => body.run as string } : {}),
  });
  return Response.json(record, { status: 201 });
}

async function handleWorkingDirectoryConfig(
  context: DaemonSystemRouteContext,
  key: string,
  value: unknown,
): Promise<Response> {
  if (!context.swapManager) {
    return jsonErrorResponse({ error: 'Workspace swapping is not available in this daemon configuration.' }, { status: 400 });
  }
  if (typeof value !== 'string' || !value.trim()) {
    return jsonErrorResponse({ error: 'runtime.workingDir value must be a non-empty string path.', code: 'INVALID_PATH' }, { status: 400 });
  }
  const result = await context.swapManager.requestSwap(value);
  if (result.ok) {
    return Response.json({
      success: true, key, value: result.current, previous: result.previous,
      // The new root works now but did not save (it is lost at restart), or some subsystems still use the old root until restart.
      ...(result.persisted !== undefined ? { persisted: result.persisted } : {}),
      ...(result.requiresRestart?.length ? { requiresRestart: result.requiresRestart } : {}),
    });
  }
  return jsonErrorResponse(
    {
      error: result.reason,
      code: result.code,
      // The swap manager counts seconds; the wire (and the retry layers) read milliseconds.
      ...(result.code === 'WORKSPACE_BUSY' && typeof result.retryAfter === 'number' ? { retryAfterMs: result.retryAfter * 1000 } : {}),
    },
    // REROOT_FAILED is the daemon failing to move its own stores, not a bad request.
    { status: result.code === 'WORKSPACE_BUSY' ? 409 : result.code === 'REROOT_FAILED' ? 500 : 400 },
  );
}

function readWatcherKind(kind: unknown, sourceKind: unknown, fallback: WatcherKind): WatcherKind {
  if (typeof kind === 'string' && (WATCHER_KIND_VALUES as readonly string[]).includes(kind)) {
    return kind as WatcherKind;
  }
  return typeof sourceKind === 'string'
    ? WATCHER_SOURCE_KIND_MAP[sourceKind] ?? fallback
    : fallback;
}

function readWatcherIntervalMs(value: unknown, fallbackValue: unknown): number {
  const fallback = typeof fallbackValue === 'number' && Number.isFinite(fallbackValue)
    ? fallbackValue
    : DEFAULT_WATCHER_INTERVAL_MS;
  return readBoundedBodyInteger(value, fallback, MAX_WATCHER_INTERVAL_MS, MIN_WATCHER_INTERVAL_MS);
}

async function handleUpdateWatcher(context: DaemonSystemRouteContext, watcherId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const literalHeaders = refuseLiteralWatcherHeaders(body);
  if (literalHeaders) return literalHeaders;
  const current = context.watcherRegistry.getWatcher(watcherId);
  if (!current) {
    return jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
  }
  const storedRun = current.metadata?.[CUSTOM_RUN_METADATA_KEY];
  const customRun = typeof storedRun === 'string' ? storedRun : undefined;
  const nextSourceKind = typeof body.sourceKind === 'string'
    ? WATCHER_SOURCE_RECORD_KIND_MAP[body.sourceKind] ?? 'watcher'
    : current.source.kind;
  const updated = context.watcherRegistry.registerWatcher({
    id: watcherId,
    label: typeof body.label === 'string' ? body.label : current.label,
    kind: readWatcherKind(body.kind, undefined, current.kind),
    source: {
      ...current.source,
      ...(typeof body.source === 'object' && body.source !== null ? body.source as Partial<typeof current.source> : {}),
      kind: nextSourceKind,
      ...(typeof body.sourceId === 'string' && body.sourceId.trim().length > 0 ? { id: body.sourceId.trim() } : {}),
      ...(typeof body.label === 'string' && body.label.trim().length > 0 ? { label: body.label.trim() } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      metadata: {
        ...current.source.metadata,
        ...(typeof body.url === 'string' ? { url: body.url } : {}),
        ...(typeof body.method === 'string' ? { method: body.method.toUpperCase() } : {}),
        ...(typeof body.path === 'string' ? { path: body.path } : {}),
        ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
        ...(typeof body.address === 'string' ? { address: body.address } : {}),
        ...(typeof body.headers === 'object' && body.headers !== null ? { headers: body.headers } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {}),
      },
      updatedAt: Date.now(),
    },
    intervalMs: body.intervalMs !== undefined ? readWatcherIntervalMs(body.intervalMs, current.intervalMs) : (current.intervalMs ?? DEFAULT_WATCHER_INTERVAL_MS),
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : current.metadata,
    // Re-registering rebuilds the default run strategy unless told otherwise.
    ...(customRun !== undefined ? { run: () => customRun } : {}),
  });
  return Response.json(updated);
}

async function handleWatcherAction(
  context: DaemonSystemRouteContext,
  watcherId: string,
  action: 'start' | 'stop' | 'run',
  _req: Request,
): Promise<Response> {
  if (action === 'start') {
    const watcher = context.watcherRegistry.startWatcher(watcherId);
    return watcher
      ? Response.json(watcher)
      : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
  }
  if (action === 'stop') {
    const watcher = context.watcherRegistry.stopWatcher(watcherId, 'operator-stop');
    return watcher
      ? Response.json(watcher)
      : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
  }
  const watcher = await context.watcherRegistry.runWatcherNow(watcherId);
  return watcher
    ? Response.json(watcher)
    : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
}

async function handleApprovalAction(
  context: DaemonSystemRouteContext,
  approvalId: string,
  action: 'claim' | 'approve' | 'deny' | 'cancel',
  req: Request,
): Promise<Response> {
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, body);
  const payload = body ?? {} as JsonRecord;
  const actor = context.requireAuthenticatedSession(req)?.username ?? 'operator';
  const note = typeof payload.note === 'string' ? payload.note : undefined;
  if (action === 'claim') {
    const outcome: { applied?: boolean | undefined } = {};
    const approval = await context.approvalBroker.claimApproval(approvalId, actor, 'web', note, outcome);
    return approval
      ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval, ...approvalActionOutcome(approval, action, actor, outcome) }))
      : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, jsonErrorResponse({ error: 'Unknown approval' }, { status: 404 }));
  }
  if (action === 'cancel') {
    const outcome: { applied?: boolean | undefined } = {};
    // A surface leaving an ask it raised releases its own claim; the ask is
    // cancelled only once no other surface that raised it is still waiting.
    const holdId = typeof payload.holdId === 'string' && payload.holdId.length > 0 ? payload.holdId : undefined;
    const approval = payload.release === true && context.approvalBroker.releaseApproval
      ? await context.approvalBroker.releaseApproval(approvalId, actor, 'web', note, outcome, holdId)
      : await context.approvalBroker.cancelApproval(approvalId, actor, 'web', note, outcome);
    return approval
      ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval, ...approvalActionOutcome(approval, action, actor, outcome) }))
      : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, jsonErrorResponse({ error: 'Unknown approval' }, { status: 404 }));
  }
  // Legacy generic callbacks choose this URL from a boolean. The URL alone
  // therefore cannot prove that an operator chose permanent workspace trust.
  const disposition = payload.disposition;
  if (disposition !== undefined && (action === 'approve'
    ? disposition !== 'approved'
    : disposition !== 'denied' && disposition !== 'amended')) {
    return context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`,
      jsonErrorResponse({ error: 'disposition must match the approval action.' }, { status: 400 }));
  }
  const selectedHunks = action === 'approve' ? readSelectedHunks(payload.selectedHunks) : undefined;
  if (selectedHunks instanceof Response) {
    return context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, selectedHunks);
  }
  // The full decision reach travels over HTTP, not just note/remember: a tier
  // grant, a deny reason, and an argument-modifying approval (e.g. the typed
  // answer to a command's terminal prompt) must all reach the same broker
  // resolution the in-process path uses. Malformed values are honest 400s,
  // silently dropping them is exactly the defect this closes.
  const rememberTier = readRememberTier(payload.rememberTier);
  if (rememberTier instanceof Response) {
    return context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, rememberTier);
  }
  if (payload.reason !== undefined && typeof payload.reason !== 'string') {
    return context.recordApiResponse(
      req,
      `/api/approvals/${approvalId}/${action}`,
      jsonErrorResponse({ error: 'reason must be a string.' }, { status: 400 }),
    );
  }
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  const modifiedArgs = action === 'approve' ? readModifiedArgs(payload.modifiedArgs) : undefined;
  if (modifiedArgs instanceof Response) {
    return context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, modifiedArgs);
  }
  let approval: unknown | null;
  const outcome: { applied?: boolean | undefined } = {};
  try {
    approval = await context.approvalBroker.resolveApproval(approvalId, {
      outcome,
      approved: action === 'approve',
      ...(disposition !== undefined ? { disposition: disposition as 'approved' | 'denied' | 'amended' } : {}),
      remember: typeof payload.remember === 'boolean' ? payload.remember : false,
      actor,
      actorSurface: 'web',
      note,
      ...(selectedHunks !== undefined ? { selectedHunks } : {}),
      ...(rememberTier !== undefined ? { rememberTier } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(modifiedArgs !== undefined ? { modifiedArgs } : {}),
    });
  } catch (error) {
    // The broker throws a 400-tagged error for an out-of-range or non-edit
    // per-hunk selection. Surface it as an honest HTTP 400, not a 500.
    const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500;
    const message = error instanceof Error ? error.message : 'Approval resolution failed.';
    return context.recordApiResponse(
      req,
      `/api/approvals/${approvalId}/${action}`,
      jsonErrorResponse({ error: message }, { status }),
    );
  }
  return approval
    ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval, ...approvalActionOutcome(approval, action, actor, outcome), recorded: recordedDecision(approval) }))
    : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, jsonErrorResponse({ error: 'Unknown approval' }, { status: 404 }));
}

/**
 * Compare a requested config value against what the host holds afterwards.
 *
 * Structural, because settings hold objects and arrays as well as scalars, and
 * a config manager legitimately normalizes on the way in (trimming, filling a
 * default sibling). Equal-by-value is the honest test of "did the write take".
 */
function configValuesMatch(current: unknown, requested: unknown): boolean {
  if (Object.is(current, requested)) return true;
  // The manager coerces a scalar to the key's type ("8080" becomes 8080, "true"
  // becomes true) and trims strings; that is the write taking, not failing.
  if (isScalar(current) && isScalar(requested)) return String(current).trim() === String(requested).trim();
  try {
    return JSON.stringify(current) === JSON.stringify(requested);
  } catch {
    return false;
  }
}

function normalizeRequested(context: DaemonSystemRouteContext, key: string, value: unknown): unknown {
  try {
    return context.coerceConfigValue ? context.coerceConfigValue(key, value) : value;
  } catch {
    return value;
  }
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isSecretReference(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('goodvibes://secrets/');
}

const REDACTED_CONFIG_VALUE = '[redacted]';

/**
 * Copy of the config with every credential-bearing literal replaced, so a read
 * never returns a secret that an older write or a hand edit left in the file.
 * A `goodvibes://secrets/` reference is the correct at-rest shape and stays.
 */
function redactSecretConfigValues(context: DaemonSystemRouteContext, config: Record<string, unknown>): Record<string, unknown> {
  const isSecret = context.isSecretBearingConfigKey;
  if (!isSecret) return config;
  const walk = (node: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (isJsonRecord(value)) out[name] = walk(value, path);
      else if (typeof value === 'string' && value !== '' && isSecret(path) && !isSecretReference(value)) out[name] = REDACTED_CONFIG_VALUE;
      else out[name] = value;
    }
    return out;
  };
  return walk(config, '');
}

/**
 * Read an optional rememberTier off the request payload. Undefined when
 * absent; a 400 Response when present but not one of the broker's tiers.
 */
function readRememberTier(value: unknown): ApprovalRememberTier | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(APPROVAL_REMEMBER_TIERS as readonly string[]).includes(value)) {
    return jsonErrorResponse(
      { error: `rememberTier must be one of: ${APPROVAL_REMEMBER_TIERS.join(', ')}.` },
      { status: 400 },
    );
  }
  return value as ApprovalRememberTier;
}

/**
 * Read an optional modifiedArgs record off the request payload. Undefined
 * when absent; a 400 Response when present but not a plain object.
 */
function readModifiedArgs(value: unknown): Record<string, unknown> | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return jsonErrorResponse({ error: 'modifiedArgs must be an object of tool arguments.' }, { status: 400 });
  }
  return value as Record<string, unknown>;
}

const APPROVAL_ACTION_TARGET = { claim: 'claimed', approve: 'approved', deny: 'denied', cancel: 'cancelled' } as const;

/**
 * Whether this call changed the approval, as reported by the broker call itself.
 *
 * An action on an approval that already ended returns that record unchanged
 * with 200, deliberately: a surface that raced a decision made elsewhere, and
 * a write-back retried after a failed write, both must not fail. `applied`
 * is what tells such a caller that nothing changed, and `refusal` says why in
 * terms a person or an agent can act on, rather than a success toast for an
 * expired ask.
 */
function approvalActionOutcome(
  approval: unknown,
  action: keyof typeof APPROVAL_ACTION_TARGET,
  actor: string,
  outcome: { applied?: boolean | undefined },
): { applied: boolean; refusal?: string } {
  const record = isJsonRecord(approval) ? approval : {};
  const status = typeof record.status === 'string' ? record.status : 'unknown';
  const target = APPROVAL_ACTION_TARGET[action];
  const by = action === 'claim' ? record.claimedBy : record.resolvedBy;
  // The broker says whether this call moved the record; callers sharing one
  // actor name cannot be told apart by comparing names. A broker that does not
  // report it falls back to comparing the actor.
  const applied = typeof outcome.applied === 'boolean' ? outcome.applied && status === target : status === target && by === actor;
  if (applied) return { applied: true };
  const resolvedBy = typeof record.resolvedBy === 'string' ? ` by ${record.resolvedBy}` : '';
  return {
    applied: false,
    refusal: status === 'pending' || status === 'claimed'
      ? `Approval is still ${status}; this ${action} was not recorded. Read the approval again and retry.`
      : `Approval is ${status}${resolvedBy}, which is final; it cannot become ${target}. Nothing changed.`,
  };
}

/**
 * What the broker actually recorded, derived from the RETURNED record,
 * never echoed from the request. An already-resolved approval keeps its
 * original decision, so this stays honest when a late approve/deny no-ops.
 */
function recordedDecision(approval: unknown): {
  approved: boolean;
  rememberTier: ApprovalRememberTier | null;
  reasonStored: boolean;
  modifiedArgsDelivered: boolean;
} {
  const decision = (approval as { decision?: {
    approved?: unknown;
    rememberTier?: unknown;
    reason?: unknown;
    modifiedArgs?: unknown;
  } | undefined }).decision;
  return {
    approved: decision?.approved === true,
    rememberTier: typeof decision?.rememberTier === 'string' && (APPROVAL_REMEMBER_TIERS as readonly string[]).includes(decision.rememberTier)
      ? decision.rememberTier as ApprovalRememberTier
      : null,
    reasonStored: typeof decision?.reason === 'string',
    modifiedArgsDelivered: decision?.modifiedArgs !== undefined,
  };
}

/**
 * Read an optional selectedHunks array off the request payload. Returns the
 * validated number[] when present and well-formed, undefined when absent, or a
 * 400 Response when present but malformed (non-array, or an entry that is not a
 * finite integer). Range validation against the specific approval's hunk count
 * is the broker's job (it owns the pending edit list).
 */
function readSelectedHunks(value: unknown): readonly number[] | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => Number.isInteger(entry))) {
    return jsonErrorResponse({ error: 'selectedHunks must be an array of integer hunk indices.' }, { status: 400 });
  }
  return value as readonly number[];
}

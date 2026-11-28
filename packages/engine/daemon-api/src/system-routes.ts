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
import { requestActor, systemActor } from './http-policy.js';
import type {
  ApprovalActionResultLike,
  ApprovalRememberTier,
  AutomationRouteBindingKind,
  DaemonSystemRouteContext,
  PlatformServiceAction,
  RouteBindingSurfaceKind,
  WatcherKind,
  WatcherSourceKind,
  WatcherSourceRecord,
} from './system-route-types.js';
import {
  APPROVAL_REMEMBER_TIERS,
  AUTOMATION_DELIVERY_GUARANTEES,
  AUTOMATION_SESSION_POLICIES,
  AUTOMATION_THREAD_POLICIES,
  ROUTE_BINDING_KINDS,
  ROUTE_BINDING_SURFACE_KINDS,
  WATCHER_KINDS,
} from './system-route-types.js';
import type { WatcherRecord } from './system-route-types.js';
import { RefusalError } from '@goodvibes/engine/errors';
import { readSettingAct, type SettingAct } from './setting-act.js';
import { keepReachableNaming } from './pagination.js';

async function serviceAction(context: DaemonSystemRouteContext, req: Request, action: PlatformServiceAction): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const manager = context.platformServiceManager;
  return Response.json(manager.requestFromDaemon ? await manager.requestFromDaemon(action) : manager[action]());
}

/** Every kind a watcher can be (system-route-types.ts `WATCHER_KINDS`, the registry's own): `manual` among them. */
const WATCHER_KIND_VALUES: readonly WatcherKind[] = WATCHER_KINDS;

function isOneOf<T extends string>(accepted: readonly T[], value: string): value is T {
  return (accepted as readonly string[]).includes(value);
}

/**
 * A choice field: a string outside `accepted` is a 400 naming the field and the
 * accepted values; any other non-string value reads as absent.
 */
function readChoice<T extends string>(value: unknown, field: string, accepted: readonly T[]): T | undefined | Response {
  if (typeof value !== 'string') return undefined;
  if (isOneOf(accepted, value)) return value;
  return jsonErrorResponse({
    error: `${field} must be one of ${accepted.join(', ')}; got "${value}". Nothing was changed.`,
    code: 'INVALID_ARGUMENT',
    field,
  }, { status: 400 });
}
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
const DEFAULT_WATCHER_INTERVAL_MS = 60_000;
const MIN_WATCHER_INTERVAL_MS = 1_000;
const MAX_WATCHER_INTERVAL_MS = 86_400_000;

interface RouteBindingCreateBody {
  readonly surfaceKind: RouteBindingSurfaceKind;
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
    const checkedSurface = readChoice(surfaceKind, 'surfaceKind', ROUTE_BINDING_SURFACE_KINDS);
    if (checkedSurface === undefined || checkedSurface instanceof Response) return checkedSurface ?? jsonErrorResponse({ error: 'Missing surfaceKind' }, { status: 400 });
    const checkedKind = readChoice(kind, 'kind', ROUTE_BINDING_KINDS);
    if (checkedKind === undefined || checkedKind instanceof Response) return checkedKind ?? jsonErrorResponse({ error: 'Missing kind' }, { status: 400 });
    return {
      surfaceKind: checkedSurface,
      kind: checkedKind,
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
        ? watcherResponse(context, { removed: true, id: watcherId })
        : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
    },
    // Admin only: the status carries the installed unit file, which can hold the
    // operator token, and install/start/stop beside it are admin only too.
    getServiceStatus: async (req?: Request) => {
      // A caller that cannot pass the request cannot be checked, so it never
      // receives the unit file.
      const admin = req ? context.requireAdmin(req) : null;
      if (admin) return admin;
      const manager = context.platformServiceManager;
      const full = manager.statusAsync ? await manager.statusAsync() : manager.status();
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
    installService: (req) => serviceAction(context, req, 'install'),
    startService: (req) => serviceAction(context, req, 'start'),
    stopService: (req) => serviceAction(context, req, 'stop'),
    restartService: (req) => serviceAction(context, req, 'restart'),
    uninstallService: (req) => serviceAction(context, req, 'uninstall'),
    getRouteBindings: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      // A binding is of the session, schedule and run it names: a caller that is not the owner in person is listed only
      // those it may reach every one of (pagination.ts keepReachableNaming, platform control-plane/caller-reach.ts).
      const field = (binding: unknown, key: string): string | undefined => {
        const value = binding !== null && typeof binding === 'object' ? (binding as Record<string, unknown>)[key] : undefined;
        return typeof value === 'string' ? value : undefined;
      };
      return Response.json({ bindings: keepReachableNaming(context.routeBindings.listBindings(), [
        ['session', (binding) => field(binding, 'sessionId')], ['schedule', (binding) => field(binding, 'jobId')], ['schedule-run', (binding) => field(binding, 'runId')],
      ]) });
    },
    postRouteBinding: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = systemBodySchemas.routeBindingCreate.parse(body);
      if (input instanceof Response) return input;
      const sessionPolicy = readChoice(body.sessionPolicy, 'sessionPolicy', AUTOMATION_SESSION_POLICIES);
      if (sessionPolicy instanceof Response) return sessionPolicy;
      const threadPolicy = readChoice(body.threadPolicy, 'threadPolicy', AUTOMATION_THREAD_POLICIES);
      if (threadPolicy instanceof Response) return threadPolicy;
      const deliveryGuarantee = readChoice(body.deliveryGuarantee, 'deliveryGuarantee', AUTOMATION_DELIVERY_GUARANTEES);
      if (deliveryGuarantee instanceof Response) return deliveryGuarantee;
      const binding = await context.routeBindings.upsertBinding({
        id: typeof body.id === 'string' ? body.id : undefined,
        kind: input.kind,
        surfaceKind: input.surfaceKind,
        surfaceId: input.surfaceId,
        externalId: input.externalId,
        sessionPolicy,
        threadPolicy,
        deliveryGuarantee,
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
      const sessionPolicy = readChoice(body.sessionPolicy, 'sessionPolicy', AUTOMATION_SESSION_POLICIES);
      if (sessionPolicy instanceof Response) return sessionPolicy;
      const threadPolicy = readChoice(body.threadPolicy, 'threadPolicy', AUTOMATION_THREAD_POLICIES);
      if (threadPolicy instanceof Response) return threadPolicy;
      const deliveryGuarantee = readChoice(body.deliveryGuarantee, 'deliveryGuarantee', AUTOMATION_DELIVERY_GUARANTEES);
      if (deliveryGuarantee instanceof Response) return deliveryGuarantee;
      const updated = await context.routeBindings.patchBinding(bindingId, {
        ...(body.sessionPolicy !== undefined ? { sessionPolicy } : {}),
        ...(body.threadPolicy !== undefined ? { threadPolicy } : {}),
        ...(body.deliveryGuarantee !== undefined ? { deliveryGuarantee } : {}),
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
    getApprovals: (url, req) => {
      if (!context.integrationHelpers) {
        return jsonErrorResponse({ error: 'Integration helper service unavailable' }, { status: 503 });
      }
      const approvalId = url?.searchParams.get('approvalId')?.trim() || undefined;
      // Each record carries its reading for this caller: what is waiting, on whom, until when, what the caller may do now.
      const viewer = context.approvalBroker.viewerOf(context.resolveAuthenticatedPrincipal?.(req)?.actor);
      const rows = approvalId === undefined ? context.approvalBroker.list(viewer, 50)
        : [context.approvalBroker.get(approvalId, viewer)].filter((row) => row !== null);
      const snapshot = context.integrationHelpers.getApprovalSnapshot(approvalId);
      return Response.json({
        ...(isJsonRecord(snapshot) ? snapshot : {}),
        // An open ask carries its words: compact in the list, in full when one approval is read.
        approvals: rows.map((row) => ({ ...(isJsonRecord(row.record) ? row.record : {}), reading: row.reading,
          ...(row.presentation !== undefined ? { presentation: row.presentation } : {}) })),
      });
    },
    // A decision grants or withholds tool execution (and can persist a durable
    // rule), so it takes the same authority as the other state changes here.
    // Shared and paired-device tokens are admin; only a non-admin user session is refused.
    approvalAction: (approvalId, action, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      // Answering an approval is the owner's own act (`approval.answer` in the effect table): the
      // catalog gate refused every other caller, the Agent's model included, before this route ran.
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
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const payload = await context.parseJsonBody(req);
      if (payload instanceof Response) return payload;
      // The owner lane takes the caller's authority itself and checks it once
      // more immediately before the write, so it is not checked again here.
      if (Object.hasOwn(payload, 'settingsPrecondition')) {
        const arm = isJsonRecord(payload.settingsPrecondition) ? payload.settingsPrecondition : null;
        if (arm && arm.action === 'write' && typeof arm.key === 'string' && arm.key) {
          const key = arm.key;
          const reset = arm.operation === 'reset-default';
          const value = arm.value;
          const unbound = reset ? context.configManager.resetRefusal?.(key) ?? null : null;
          if (unbound) {
            return jsonErrorResponse({ error: unbound.reason, code: unbound.code, state: unbound.state, next: [...unbound.next] },
              { status: unbound.status ?? 409 });
          }
          const putToOwner = await ownerActResponse(context, req, '/config', [{ key, value, ...(reset ? { toDefault: true } : {}) }]);
          if (putToOwner) return putToOwner;
        }
      }
      if (Object.hasOwn(payload, 'settingsPrecondition')) {
        return context.settingsPrecondition?.handle(req, payload, requestLifetime)
          ?? jsonErrorResponse({ error: 'Settings owner precondition unavailable', code: 'SETTINGS_PRECONDITION_UNSUPPORTED' }, { status: 409 });
      }
      // Body parsing yields; the plain write has no owner lane, so the admin check is repeated before it.
      const currentAdmin = context.requireAdmin(req);
      if (currentAdmin) return currentAdmin;
      const { key, value } = payload;
      if (!key || typeof key !== 'string') {
        return jsonErrorResponse({ error: 'Missing or invalid key' }, { status: 400 });
      }
      if (key === 'runtime.workingDir') {
        return handleWorkingDirectoryConfig();
      }
      if (!context.isValidConfigKey(key)) {
        return jsonErrorResponse({ error: 'Invalid config key' }, { status: 400 });
      }
      // A credential never goes into a config file as a literal. credentials.set
      // files it in the secret store and leaves a reference; a value that already
      // is such a reference is safe to write here.
      if (context.isSecretBearingConfigKey?.(key) && !isSecretReference(value)) {
        return jsonErrorResponse(
          {
            error: `Config key ${key} holds a credential and is not written to the config file as plain text.`,
            code: 'SECRET_CONFIG_KEY', state: 'the setting is unchanged',
            next: [`Store it with credentials.set { "key": "${key}", "value": "<secret>" }, which files it in the secret store and points ${key} at it.`,
              'Or pass a goodvibes://secrets/ reference to config.set.'],
          },
          { status: 400 },
        );
      }
      const putToOwner = await ownerActResponse(context, req, '/config', [{ key, value }]);
      if (putToOwner) return putToOwner;
      // The owner question may have yielded; the caller's authority is read again before the write.
      const writeAdmin = context.requireAdmin(req);
      if (writeAdmin) return writeAdmin;
      try {
        // Who made it and how it was decided, as the daemon's dispatch bound it: kept with the change.
        context.configManager.setDynamic(key, value, settingPress(req));
      } catch (error: unknown) {
        if (error instanceof RefusalError) return jsonErrorResponse(error, { status: error.refusal.status ?? 400 });
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
    postConfigMany: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const payload = await context.parseJsonBody(req);
      if (payload instanceof Response) return payload;
      // Body parsing yields. Reacquire current admin before the write.
      const currentAdmin = context.requireAdmin(req);
      if (currentAdmin) return currentAdmin;
      const unchanged = 'nothing was saved';
      const requested = payload.entries;
      if (!Array.isArray(requested) || requested.length === 0) {
        return jsonErrorResponse({ error: 'The request names no settings to write.', code: 'INVALID_ARGUMENT', state: unchanged,
          next: ['Send { "entries": [{ "key": "<config key>", "value": <value> }] }; config.get lists the keys.'] }, { status: 400 });
      }
      const changes: { readonly key: string; readonly value: unknown }[] = [];
      for (const entry of requested) {
        const key = isJsonRecord(entry) && typeof entry.key === 'string' ? entry.key : '';
        if (!key || !isJsonRecord(entry) || !Object.hasOwn(entry, 'value')) {
          return jsonErrorResponse({ error: 'Every entry needs a key and a value.', code: 'INVALID_ARGUMENT', state: unchanged,
            next: ['Send each entry as { "key": "<config key>", "value": <value> }.'] }, { status: 400 });
        }
        // No caller moves the daemon: it serves every project at once.
        if (key === 'runtime.workingDir') return handleWorkingDirectoryConfig();
        if (!context.isValidConfigKey(key)) {
          return jsonErrorResponse({ error: `${key} is not a config key this daemon knows.`, code: 'INVALID_ARGUMENT', state: unchanged,
            next: ['Check the key name; config.get lists the keys.'] }, { status: 400 });
        }
        if (context.isSecretBearingConfigKey?.(key) && !isSecretReference(entry.value)) {
          return jsonErrorResponse({ error: `Config key ${key} holds a credential and is not written to the config file as plain text.`,
            code: 'SECRET_CONFIG_KEY', state: unchanged,
            next: [`Store it with credentials.set { "key": "${key}", "value": "<secret>" }, then send its goodvibes://secrets/ reference here.`] },
          { status: 400 });
        }
        changes.push({ key, value: entry.value });
      }
      if (!context.configManager.setMany) {
        return jsonErrorResponse({ error: 'This host cannot write several settings as one update.', code: 'CONFIG_SET_MANY_UNSUPPORTED', state: unchanged,
          next: ['Send each setting with config.set.'] }, { status: 409 });
      }
      const putToOwner = await ownerActResponse(context, req, '/config/many', changes);
      if (putToOwner) return putToOwner;
      const writeAdmin = context.requireAdmin(req);
      if (writeAdmin) return writeAdmin;
      // One admission, one write per settings file, one revision and one change event per key.
      // ownerActResponse above already admitted any loosening change (via the active mode or user approval),
      // so unwrap an agent actor to its principal before writing.
      const rawWriter = context.resolveAuthenticatedPrincipal?.(req)?.actor ?? systemActor('daemon-api');
      const writer = rawWriter.agentFor ?? rawWriter;
      const result = context.configManager.setMany(changes, writer, settingPress(req));
      if (!result.ok) {
        const { refusal } = result;
        return jsonErrorResponse({ error: refusal.reason, code: refusal.code, state: refusal.state, next: [...refusal.next],
          ...(refusal.retryable ? { recoverable: true } : {}) }, { status: refusal.status ?? 409 });
      }
      // Report what the host now HOLDS per key, and refuse success when a key
      // did not take (a higher tier overrides it, or it was coerced to another value).
      const held = changes.map(({ key, value }) => {
        const source = context.configManager.describeConfigKeySource?.(key);
        const persistedTo = (source?.daemonOwned ? source.daemonTierPath : null) ?? context.configManager.getConfigPath?.();
        const current = context.configManager.get(key);
        const applied = configValuesMatch(current, value) || configValuesMatch(current, normalizeRequested(context, key, value));
        return {
          applied,
          origin: source?.effectiveOrigin,
          entry: {
            key,
            value: current,
            ...(persistedTo ? { persistedTo } : {}),
            ...(source ? { tier: source.tier, daemonOwned: source.daemonOwned,
              ...(source.effectiveOrigin ? { effectiveOrigin: source.effectiveOrigin } : {}) } : {}),
          },
        };
      });
      const entries = held.map(({ entry }) => entry);
      const notApplied = held.filter(({ applied }) => !applied);
      if (notApplied.length > 0) {
        const keys = notApplied.map(({ entry }) => entry.key);
        const described = notApplied.map(({ entry, origin }) => (context.isSecretBearingConfigKey?.(entry.key)
          ? entry.key
          : `${entry.key} (now ${JSON.stringify(entry.value)}${origin ? `, set by ${origin}` : ''})`));
        // Built directly: the shared error body keeps only its own fields, and the
        // keys, revision and held values are what a caller acts on here.
        return Response.json({
          error: `${keys.join(', ')} did not take the requested value${keys.length === 1 ? '' : 's'}.`,
          code: 'CONFIG_SET_NOT_APPLIED',
          status: 409,
          state: `the update was written (revision ${String(result.revision)}), but the host holds a different value for ${described.join('; ')}`,
          next: ['Check where each of these keys is set with config.get; a value from a higher tier (managed, environment or daemon-owned settings) overrides the one written here.'],
          notApplied: keys,
          revision: result.revision,
          entries,
        }, { status: 409 });
      }
      return Response.json({
        success: true,
        revision: result.revision,
        entries,
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
      const unchanged = 'the setting is unchanged';
      if (!key || typeof key !== 'string') {
        return jsonErrorResponse({ error: 'The request names no config key.', code: 'INVALID_ARGUMENT', state: unchanged,
          next: ['Send { "key": "<config key>" }; config.get lists the keys.'] }, { status: 400 });
      }
      // No caller moves the daemon: it serves every project at once.
      if (key === 'runtime.workingDir') {
        return handleWorkingDirectoryConfig();
      }
      if (!context.isValidConfigKey(key)) {
        return jsonErrorResponse({ error: `${key} is not a config key this daemon knows.`, code: 'INVALID_ARGUMENT', state: unchanged,
          next: ['Check the key name; config.get lists the keys.'] }, { status: 400 });
      }
      // Resetting would leave the stored secret behind with nothing pointing at it.
      if (context.isSecretBearingConfigKey?.(key)) {
        return jsonErrorResponse({ error: `Config key ${key} holds a credential, and a reset would leave the stored secret behind.`,
          code: 'SECRET_CONFIG_KEY', state: unchanged,
          next: ['Remove it with credentials.delete, which clears the stored secret and then the reference.'] }, { status: 400 });
      }
      if (!context.configManager.reset) {
        return jsonErrorResponse({ error: 'This host cannot reset a setting.', code: 'CONFIG_RESET_UNSUPPORTED', state: unchanged,
          next: ['Write the default value with config.set instead.'] }, { status: 409 });
      }
      // A reset of a destination moves its credential to the default destination: refused before anything is asked or done.
      const unbound = context.configManager.resetRefusal?.(key) ?? null;
      if (unbound) {
        return jsonErrorResponse({ error: unbound.reason, code: unbound.code, state: unbound.state, next: [...unbound.next] },
          { status: unbound.status ?? 409 });
      }
      const putToOwner = await ownerActResponse(context, req, '/config/reset', [{ key, value: undefined, toDefault: true }]);
      if (putToOwner) return putToOwner;
      const writeAdmin = context.requireAdmin(req);
      if (writeAdmin) return writeAdmin;
      try {
        // The manager owns the managed-policy lock and refuses a locked key here.
        context.configManager.reset(key, settingPress(req));
      } catch (error: unknown) {
        if (error instanceof RefusalError) return jsonErrorResponse(error, { status: error.refusal.status ?? 400 });
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

/**
 * A `run` text was never executed: the watcher recorded it as a fixed
 * checkpoint and reported heartbeats that observed nothing.
 */
function refuseRunText(body: Record<string, unknown>): Response | null {
  if (body.run === undefined) return null;
  return jsonErrorResponse(
    {
      error: 'A watcher run text is not executed: the watcher would report heartbeats without observing anything. Nothing was changed.',
      code: 'WATCHER_RUN_TEXT_UNSUPPORTED',
      state: 'the watcher was not changed',
      next: ["Remove run and give the watcher kind 'webhook' or 'polling' with a url, 'filesystem' with a path, or 'manual'"],
    },
    { status: 400 },
  );
}

/**
 * The watcher answer, saying so when the change holds only until the next
 * restart because the watcher store could not be saved. Hosts that do not
 * expose the save state answer as before.
 */
function watcherResponse(context: DaemonSystemRouteContext, body: WatcherRecord | Record<string, unknown>, status = 200): Response {
  const failure = context.watcherRegistry.snapshotSaveFailure?.();
  if (failure === undefined) return Response.json(body, { status });
  return Response.json({
    ...body,
    persisted: false,
    notice: `The change is in effect now, but the watcher store ${failure.filePath} could not be saved (${failure.code ?? failure.error}), so a restart would not keep it. `
      + 'Free space or fix the permissions on that path; the next watcher change or run saves it again.',
  }, { status });
}

/** A registry refusal (nothing to run, waiting for its owner) as its own status and body. */
function watcherRefusal(error: unknown): Response {
  if (error instanceof RefusalError) return jsonErrorResponse(error, { status: error.refusal.status ?? 400 });
  throw error;
}

async function handleRegisterWatcher(context: DaemonSystemRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const literalHeaders = refuseLiteralWatcherHeaders(body);
  if (literalHeaders) return literalHeaders;
  const runText = refuseRunText(body);
  if (runText) return runText;
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
  if (kind instanceof Response) return kind;
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
    return jsonErrorResponse({
      error: `Watcher ${id} already exists, so registering it again would replace it.`,
      code: 'WATCHER_EXISTS',
      state: `watcher ${id} is unchanged`,
      next: [`PATCH /api/watchers/${id} to change it`, 'Or register it with a different label or id'],
    }, { status: 409 });
  }
  let record: WatcherRecord;
  try {
    record = context.watcherRegistry.registerWatcher({
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
      metadata: sourceMetadata,
    });
  } catch (error) {
    return watcherRefusal(error);
  }
  return watcherResponse(context, record, 201);
}

/**
 * The daemon serves every project at once and keeps its own records in its home, so it has no working folder a
 * caller can change: each session, runner and program works in its own project, named on each call.
 */
function handleWorkingDirectoryConfig(): Response {
  return jsonErrorResponse({
    error: 'runtime.workingDir is not a daemon setting: the daemon serves every project at once and no caller moves it',
    code: 'WORKSPACE_CHANGE_UNAVAILABLE', state: 'nothing was changed',
    next: ['Name the project on each call (workingDirectory), or open GoodVibes in that folder; a runner or hosted session is started with its own folder.'],
  }, { status: 409 });
}

/**
 * The kind a watcher is made or changed to: the kind named (each of `WATCHER_KIND_VALUES`, so a `manual` watcher is
 * manual, never read as polling), else the one its source kind names, else `fallback`. A kind named that is none of
 * them is a 400 naming the kinds: a watcher never silently becomes another kind than the one asked for.
 */
function readWatcherKind(kind: unknown, sourceKind: unknown, fallback: WatcherKind): WatcherKind | Response {
  const named = readChoice(kind, 'kind', WATCHER_KIND_VALUES);
  if (named !== undefined) return named;
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
  const runText = refuseRunText(body);
  if (runText) return runText;
  const current = context.watcherRegistry.getWatcher(watcherId);
  if (!current) {
    return jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
  }
  const nextSourceKind: WatcherSourceKind = typeof body.sourceKind === 'string'
    ? WATCHER_SOURCE_RECORD_KIND_MAP[body.sourceKind] ?? 'watcher'
    : current.source.kind;
  const sourcePatch = readWatcherSourcePatch(body.source);
  if (sourcePatch instanceof Response) return sourcePatch;
  const kind = readWatcherKind(body.kind, undefined, current.kind);
  if (kind instanceof Response) return kind;
  let updated: WatcherRecord;
  try {
    updated = context.watcherRegistry.registerWatcher({
      id: watcherId,
      label: typeof body.label === 'string' ? body.label : current.label,
      kind,
      source: {
        ...current.source,
        ...sourcePatch,
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
    });
  } catch (error) {
    return watcherRefusal(error);
  }
  return watcherResponse(context, updated);
}

/**
 * The source fields a watcher update may set through `source`. Its id, label,
 * enablement and metadata have their own top-level fields; the store's own
 * stamps (created, updated, last seen) are never taken from a request.
 */
function readWatcherSourcePatch(value: unknown): Partial<Pick<WatcherSourceRecord, 'routeId' | 'surfaceKind'>> | Response {
  if (value === undefined || value === null) return {};
  if (!isJsonRecord(value)) return jsonErrorResponse({ error: 'source must be an object.', code: 'INVALID_ARGUMENT', field: 'source' }, { status: 400 });
  if (value.routeId !== undefined && typeof value.routeId !== 'string') {
    return jsonErrorResponse({ error: 'source.routeId must be a string.', code: 'INVALID_ARGUMENT', field: 'source.routeId' }, { status: 400 });
  }
  const surfaceKind = value.surfaceKind === undefined ? undefined : readChoice(value.surfaceKind, 'source.surfaceKind', ROUTE_BINDING_SURFACE_KINDS);
  if (surfaceKind instanceof Response) return surfaceKind;
  if (value.surfaceKind !== undefined && surfaceKind === undefined) {
    return jsonErrorResponse({ error: `source.surfaceKind must be one of ${ROUTE_BINDING_SURFACE_KINDS.join(', ')}.`, code: 'INVALID_ARGUMENT', field: 'source.surfaceKind' }, { status: 400 });
  }
  return {
    ...(typeof value.routeId === 'string' ? { routeId: value.routeId } : {}),
    ...(surfaceKind ? { surfaceKind } : {}),
  };
}

async function handleWatcherAction(
  context: DaemonSystemRouteContext,
  watcherId: string,
  action: 'start' | 'stop' | 'run',
  _req: Request,
): Promise<Response> {
  let watcher: WatcherRecord | null;
  try {
    watcher = action === 'start'
      ? context.watcherRegistry.startWatcher(watcherId)
      : action === 'stop'
        ? context.watcherRegistry.stopWatcher(watcherId, 'operator-stop')
        : await context.watcherRegistry.runWatcherNow(watcherId);
  } catch (error) {
    return watcherRefusal(error);
  }
  return watcher
    ? watcherResponse(context, watcher)
    : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
}

async function handleApprovalAction(
  context: DaemonSystemRouteContext,
  approvalId: string,
  action: 'claim' | 'approve' | 'deny' | 'cancel',
  req: Request,
): Promise<Response> {
  const path = `/api/approvals/${approvalId}/${action}`;
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return context.recordApiResponse(req, path, body);
  const payload = body ?? {} as JsonRecord;
  const actor = requestActor(context, req);
  const viewer = context.approvalBroker.viewerOf(context.resolveAuthenticatedPrincipal?.(req)?.actor);
  const note = typeof payload.note === 'string' ? payload.note : undefined;
  const answer = (outcome: ApprovalActionResultLike, extra: Record<string, unknown> = {}): Response => context.recordApiResponse(req, path,
    // Unknown is 404; an outcome that cannot be known (the owning node did not answer) is 200 with its refusal.
    outcome.record === null && (outcome.applied || outcome.refusal.code === 'UNKNOWN_APPROVAL')
      ? jsonErrorResponse({ error: outcome.applied ? 'Unknown approval' : outcome.refusal.reason, code: 'APPROVAL_NOT_FOUND',
        ...(outcome.applied ? {} : { state: outcome.refusal.state, next: [...outcome.refusal.next] }) }, { status: 404 })
      // Applied or not, the answer carries the record and the caller's reading as they are now: a raced or stale
      // action is 200 with `applied: false` and the refusal saying why, so it can be shown again in place.
      : Response.json({ applied: outcome.applied, ...(outcome.record !== null ? { approval: outcome.record, reading: outcome.reading } : {}),
        ...(outcome.applied ? {} : { refusal: outcome.refusal }), ...extra }));
  // A surface leaving an ask it raised, or confirming it received the decision, gives up its own hold; no revision needed.
  if (action === 'cancel' && payload.release === true) {
    const holdId = typeof payload.holdId === 'string' && payload.holdId.length > 0 ? payload.holdId : undefined;
    return answer(await context.approvalBroker.release(approvalId, { actor, actorSurface: 'web', note, holdId }, viewer));
  }
  // Every other action names the revision of the approval the caller showed or read (approvals.list returns it).
  const expectedRevision = payload.expectedRevision;
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return context.recordApiResponse(req, path, jsonErrorResponse({
      error: 'expectedRevision must be the revision of the approval you showed or read (approvals.list returns it on each record).',
      code: 'INVALID_ARGUMENT', field: 'expectedRevision',
    }, { status: 400 }));
  }
  if (action === 'claim') return answer(await context.approvalBroker.claim(approvalId, { actor, actorSurface: 'web', note, expectedRevision }, viewer));
  if (action === 'cancel') return answer(await context.approvalBroker.cancel(approvalId, { actor, actorSurface: 'web', note, expectedRevision }, viewer));
  // Legacy generic callbacks choose this URL from a boolean. The URL alone
  // therefore cannot prove that an operator chose permanent workspace trust.
  const disposition = payload.disposition;
  if (disposition !== undefined && (action === 'approve'
    ? disposition !== 'approved'
    : disposition !== 'denied' && disposition !== 'amended')) {
    return context.recordApiResponse(req, path,
      jsonErrorResponse({ error: 'disposition must match the approval action.', code: 'INVALID_ARGUMENT', field: 'disposition' }, { status: 400 }));
  }
  const selectedHunks = action === 'approve' ? readSelectedHunks(payload.selectedHunks) : undefined;
  if (selectedHunks instanceof Response) return context.recordApiResponse(req, path, selectedHunks);
  // The full decision reach travels over HTTP, not just note/remember: a tier
  // grant, a deny reason, and an argument-modifying approval (e.g. the typed
  // answer to a command's terminal prompt) must all reach the same broker
  // resolution the in-process path uses. Malformed values are honest 400s.
  const rememberTier = readRememberTier(payload.rememberTier);
  if (rememberTier instanceof Response) return context.recordApiResponse(req, path, rememberTier);
  if (payload.reason !== undefined && typeof payload.reason !== 'string') {
    return context.recordApiResponse(req, path,
      jsonErrorResponse({ error: 'reason must be a string.', code: 'INVALID_ARGUMENT', field: 'reason' }, { status: 400 }));
  }
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  const modifiedArgs = action === 'approve' ? readModifiedArgs(payload.modifiedArgs) : undefined;
  if (modifiedArgs instanceof Response) return context.recordApiResponse(req, path, modifiedArgs);
  let outcome: ApprovalActionResultLike;
  try {
    outcome = await context.approvalBroker.resolve(approvalId, {
      approved: action === 'approve',
      ...(disposition !== undefined ? { disposition: disposition as 'approved' | 'denied' | 'amended' } : {}),
      remember: typeof payload.remember === 'boolean' ? payload.remember : false,
      actor,
      actorSurface: 'web',
      note,
      expectedRevision,
      ...(selectedHunks !== undefined ? { selectedHunks } : {}),
      ...(rememberTier !== undefined ? { rememberTier } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(modifiedArgs !== undefined ? { modifiedArgs } : {}),
    }, viewer);
  } catch (error) {
    // The broker throws a 400-tagged error for an out-of-range or non-edit
    // per-hunk selection, and an error naming what was not saved. Surface it honestly.
    const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500;
    const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined;
    const message = error instanceof Error ? error.message : 'Approval resolution failed.';
    return context.recordApiResponse(req, path,
      jsonErrorResponse({ error: message, ...(code ? { code } : status === 400 ? { code: 'INVALID_ARGUMENT' } : {}) }, { status }));
  }
  return answer(outcome, outcome.record === null ? {} : { recorded: recordedDecision(outcome.record) });
}

/**
 * A settings write that loosens a security, permission, judgment or payment setting is decided by the one owner rule
 * (platform daemon/method-owner-decision.ts): the daemon's dispatch tells this route whether the caller is one the rule
 * admits at once (`settingsLoosenAdmission`). A caller it does not admit gets `OWNER_DECISION_NEEDED` here, nothing
 * changed, and the dispatch puts that same call to the owner's gate, as every other call of a class the owner decides; a
 * caller the effect table refuses outright is refused. Null: the write goes on (admitted, or it loosens nothing).
 */
async function ownerActResponse(
  context: DaemonSystemRouteContext,
  req: Request,
  path: string,
  changes: readonly { readonly key: string; readonly value: unknown; readonly toDefault?: boolean }[],
): Promise<Response | null> {
  // A locked setting is refused first, whoever asks: nothing is put to the owner for a write that cannot happen.
  const locked = context.managedLockRefusal ? changes.map(({ key }) => context.managedLockRefusal!(key)).filter((said): said is string => said !== null) : [];
  if (locked.length > 0) {
    return context.recordApiResponse(req, path, jsonErrorResponse({
      error: locked.join(' '), code: 'CONFIG_MANAGED', state: 'nothing was saved',
      next: ['Ask the owner: only the owner removes a managed lock (Tools and extensions, Managed settings, unlock).'],
    }, { status: 403 }));
  }
  const admission = context.settingsLoosenAdmission?.(req) ?? 'allowed';
  if (admission === 'allowed' || !context.configLoosening) return null;
  const reasons = changes.flatMap(({ key, value, toDefault }) => {
    const loosening = context.configLoosening!(key, value, toDefault ? { toDefault: true } : {});
    return loosening === null ? [] : [`Changing ${key} would ${loosening}.`];
  });
  if (reasons.length === 0) return null;
  const keys = changes.map(({ key }) => key);
  if (admission === 'ask-owner') {
    return context.recordApiResponse(req, path, jsonErrorResponse({
      error: `${reasons.join(' ')} The owner decides that change.`, code: 'OWNER_DECISION_NEEDED', keys,
    }, { status: 409 }));
  }
  return context.recordApiResponse(req, path, jsonErrorResponse({
    error: `${reasons.join(' ')} Only the owner makes that change. Nothing was changed.`,
    code: 'OWNER_ONLY', state: 'the settings are unchanged',
    next: ['Make the change from the owner\'s own app (their sign-in, a device they paired, or the terminal app or the Agent on the daemon\'s machine).'],
  }, { status: 403 }));
}

/** The write's press option carrying who made it and how it was decided (control-routes.ts `SettingAct`), when bound. */
function settingPress(req: Request): { readonly press: { readonly act: SettingAct } } | undefined {
  const act = readSettingAct(req);
  return act ? { press: { act } } : undefined;
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
      { error: `rememberTier must be one of: ${APPROVAL_REMEMBER_TIERS.join(', ')}.`, code: 'INVALID_ARGUMENT', field: 'rememberTier' },
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
    return jsonErrorResponse({ error: 'modifiedArgs must be an object of tool arguments.', code: 'INVALID_ARGUMENT', field: 'modifiedArgs' }, { status: 400 });
  }
  return value as Record<string, unknown>;
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
    return jsonErrorResponse({ error: 'selectedHunks must be an array of integer hunk indices.', code: 'INVALID_ARGUMENT', field: 'selectedHunks' }, { status: 400 });
  }
  return value as readonly number[];
}

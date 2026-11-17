import { MEMORY_RECORD_NOT_FOUND_CODE } from '@goodvibes-jev/engine/errors';
import type { DaemonIntegrationRouteHandlers } from './context.js';
import { jsonErrorResponse, readServiceErrorResponse } from './error-response.js';
import type { DaemonIntegrationRouteContext, IntegrationHelperServiceLike, MemoryRecordReviewInput } from './integration-route-types.js';
import { principalHasScope } from './http-policy.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedPositiveInteger,
  readOptionalStringField,
} from './route-helpers.js';
import {
  parseMemoryBundleImportBody,
  parseMemoryLinkBody,
  parseMemoryRecordAddBody,
  parseMemoryRecordFilterBody,
  parseMemoryRecordReviewBody,
  parseMemoryRecordSearchBody,
  parseMemoryRecordUpdateBody,
} from './memory-record-body.js';

const MAX_LOCAL_AUTH_ROLES = 32;

type EmbeddingDefaultBody = {
  readonly providerId: string;
};

type LocalAuthUserBody = {
  readonly username: string;
  readonly password: string;
  readonly roles: readonly string[];
  readonly scopes?: readonly string[] | undefined;
};

type LocalAuthScopesBody = {
  readonly scopes: readonly string[] | null;
};

/** At most this many scopes in one stored list. */
const MAX_LOCAL_AUTH_SCOPES = 256;

/**
 * A stored scope list: a nonempty array of nonempty scope names, `null` (only
 * where `allowNull`) for the role's default set, or a 400 naming the field.
 */
function readScopeList(value: unknown, allowNull: boolean): readonly string[] | null | Response {
  if (value === null && allowNull) return null;
  if (Array.isArray(value) && value.length > 0 && value.length <= MAX_LOCAL_AUTH_SCOPES
    && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
    return (value as string[]).map((entry) => entry.trim());
  }
  return jsonErrorResponse({
    error: `scopes must be an array of 1 to ${MAX_LOCAL_AUTH_SCOPES} operator scopes (such as read:sessions)${allowNull ? ', or null for the role\'s default set' : '; omit it for the role\'s default set'}. Nothing was changed.`,
    code: 'INVALID_ARGUMENT',
    field: 'scopes',
  }, { status: 400 });
}

type LocalAuthPasswordBody = {
  readonly password: string;
};

type PanelOpenBody = {
  readonly panelId: string;
  readonly pane: 'top' | 'bottom';
};

const integrationBodySchemas = createRouteBodySchemaRegistry({
  embeddingDefault: createRouteBodySchema<EmbeddingDefaultBody>('POST /api/memory/embedding/default', (body) => {
    const providerId = readOptionalStringField(body, 'providerId');
    if (!providerId) return jsonErrorResponse({ error: 'Missing providerId' }, { status: 400 });
    return { providerId };
  }),
  localAuthUser: createRouteBodySchema<LocalAuthUserBody>('POST /api/local-auth/users', (body) => {
    const username = readOptionalStringField(body, 'username');
    const password = readOptionalStringField(body, 'password');
    if (!username) return jsonErrorResponse({ error: 'Missing username' }, { status: 400 });
    if (!password) return jsonErrorResponse({ error: 'Missing password' }, { status: 400 });
    // Omitting `roles` creates an admin (the long-standing default). A `roles`
    // that is present but empty or malformed is refused: reading it as "absent"
    // would hand an admin account to a caller who asked for no roles.
    let roles: readonly string[] = ['admin'];
    if (Object.hasOwn(body, 'roles')) {
      const requested: unknown = body.roles;
      const entries = Array.isArray(requested) && requested.length <= MAX_LOCAL_AUTH_ROLES && requested.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
        ? (requested as string[]).map((entry) => entry.trim())
        : [];
      if (entries.length === 0) {
        return jsonErrorResponse({
          error: `roles must be an array of 1 to ${MAX_LOCAL_AUTH_ROLES} non-empty role names. Omit roles to create an admin user.`,
          code: 'INVALID_REQUEST',
        }, { status: 400 });
      }
      roles = entries;
    }
    if (!Object.hasOwn(body, 'scopes')) return { username, password, roles };
    const scopes = readScopeList(body.scopes, false);
    if (scopes instanceof Response) return scopes;
    return { username, password, roles, ...(scopes ? { scopes } : {}) };
  }),
  localAuthScopes: createRouteBodySchema<LocalAuthScopesBody>('POST /api/local-auth/users/:username/scopes', (body) => {
    // A missing `scopes` is refused like a malformed one: clearing the list is an explicit null.
    const scopes = readScopeList(Object.hasOwn(body, 'scopes') ? body.scopes : undefined, true);
    if (scopes instanceof Response) return scopes;
    return { scopes };
  }),
  localAuthPassword: createRouteBodySchema<LocalAuthPasswordBody>('POST /api/local-auth/users/:username/password', (body) => {
    const password = readOptionalStringField(body, 'password');
    if (!password) return jsonErrorResponse({ error: 'Missing password' }, { status: 400 });
    return { password };
  }),
  panelOpen: createRouteBodySchema<PanelOpenBody>('POST /api/integrations/panels/open', (body) => {
    const panelId = readOptionalStringField(body, 'id');
    if (!panelId) return jsonErrorResponse({ error: 'Missing panel id' }, { status: 400 });
    return {
      panelId,
      pane: body.pane === 'bottom' ? 'bottom' : 'top',
    };
  }),
});

/**
 * The reviewer on a review is whoever holds the credential, not a name in the
 * body: the store treats it as provenance, so a claimed name would forge it.
 */
function withAuthenticatedReviewer(
  context: DaemonIntegrationRouteContext,
  req: Request,
  fields: MemoryRecordReviewInput,
): MemoryRecordReviewInput {
  const { reviewedBy: _claimed, ...rest } = fields;
  const principal = context.resolveAuthenticatedPrincipal?.(req) ?? null;
  return principal ? { ...rest, reviewedBy: principal.principalId } : rest;
}

/** What a task row needs to hide when the caller may not read conversation text. */
const TASK_TEXT_WITHHELD = 'Task titles, prompts and errors need read:transcripts; the counts and states are whole.';

/**
 * The task snapshot as the caller may see it. An agent task's title and
 * description are its prompt and its error can quote the work, so a caller
 * without read:transcripts gets each row's kind as its title and no prompt or
 * error, and `withheld` says so. A request no credential resolved for (an
 * embedder without a resolver) is served whole, as before.
 */
function taskSnapshotFor(context: DaemonIntegrationRouteContext, req: Request | undefined, snapshot: unknown): unknown {
  const principal = req ? context.resolveAuthenticatedPrincipal?.(req) ?? null : null;
  if (!principal || principal.admin || principalHasScope(principal, 'read:transcripts')) return snapshot;
  const record = snapshot as { readonly tasks?: unknown } | null;
  if (!record || typeof record !== 'object' || !Array.isArray(record.tasks)) return snapshot;
  return {
    ...record,
    tasks: record.tasks.map((row: unknown) => {
      if (!row || typeof row !== 'object') return row;
      const { title: _title, description: _description, error: _error, ...rest } = row as Record<string, unknown>;
      return { ...rest, title: `${typeof rest['kind'] === 'string' ? rest['kind'] : 'runtime'} task` };
    }),
    withheld: TASK_TEXT_WITHHELD,
  };
}

export function createDaemonIntegrationRouteHandlers(
  context: DaemonIntegrationRouteContext,
): DaemonIntegrationRouteHandlers {
  return {
    getReview: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.buildReview())),
    getIntegrationSession: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getSessionSnapshot())),
    getIntegrationTasks: (limit?: number, req?: Request) => withHelpers(context.integrationHelpers, (helpers) => Response.json(taskSnapshotFor(context, req, helpers.getTaskSnapshot(limit)))),
    getIntegrationAutomation: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getAutomationSnapshot())),
    getIntegrationSessions: (url?: URL) => handleGetIntegrationSessions(context.integrationHelpers, url),
    getDeliveries: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getDeliverySnapshot())),
    getDelivery: (deliveryId) => {
      const runtimeStore = context.integrationHelpers?.getRuntimeStore() ?? null;
      const delivery = runtimeStore?.getState().deliveries.deliveryAttempts.get(deliveryId);
      if (!delivery) {
        return jsonErrorResponse({ error: 'Unknown delivery' }, { status: 404 });
      }
      return Response.json({ delivery });
    },
    getRoutesSnapshot: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getRouteSnapshot())),
    getRemote: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getRemoteSnapshot())),
    getHealth: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getHealthSnapshot())),
    getAccounts: async () => {
      if (!context.integrationHelpers) {
        return jsonErrorResponse({ error: 'Integration helper service unavailable' }, { status: 503 });
      }
      return Response.json(await context.integrationHelpers.getAccountsSnapshot());
    },
    getProviders: async () => Response.json({ providers: await context.providerRuntime.listSnapshots() }),
    getProvider: async (providerId) => {
      const provider = await context.providerRuntime.getSnapshot(providerId);
      return provider
        ? Response.json(provider)
        : jsonErrorResponse({ error: 'Unknown provider' }, { status: 404 });
    },
    getProviderUsage: async (providerId) => {
      const usage = await context.providerRuntime.getUsageSnapshot(providerId);
      return usage
        ? Response.json(usage)
        : jsonErrorResponse({ error: 'Unknown provider' }, { status: 404 });
    },
    getSettings: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getSettingsSnapshot()));
    },
    getSecuritySettings: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return withHelpers(context.integrationHelpers, (helpers) => Response.json({
        settings: helpers.getSecuritySettingsReport(),
      }));
    },
    getContinuity: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getContinuitySnapshot())),
    getWorktrees: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getWorktreeSnapshot())),
    getIntelligence: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getIntelligenceSnapshot())),
    getMemoryDoctor: async () => Response.json(await context.memoryRegistry.doctor()),
    getMemoryConsolidationReceipts: () => {
      // What consolidation DID (retained run receipts) and what it PROPOSED and
      // a person has not decided yet. The proposals come from the memory store
      // with their ids; each is decided with memory.consolidation.decide, which
      // changes the records it names or records that they stand, and a decided
      // proposal is no longer listed. A scheduler without a proposal store falls
      // back to the proposals of its retained receipts.
      if (!context.memoryConsolidation) {
        return jsonErrorResponse({ error: 'This runtime has no memory-consolidation scheduler.' }, { status: 501 });
      }
      const scheduler = context.memoryConsolidation as typeof context.memoryConsolidation & { listProposals?: () => readonly unknown[] };
      const receipts = scheduler.listReceipts();
      const proposed = receipts.flatMap((receipt) => {
        const entries = (receipt as { proposed?: unknown }).proposed;
        return Array.isArray(entries) ? entries : [];
      });
      const pendingProposals = scheduler.listProposals ? [...scheduler.listProposals()] : proposed;
      const keyOf = (proposal: unknown): string => {
        const { kind, ids } = (proposal ?? {}) as { kind?: unknown; ids?: unknown };
        return `${String(kind)}:${Array.isArray(ids) ? ids.map(String).sort().join(',') : ''}`;
      };
      const pending = new Set(pendingProposals.map(keyOf));
      const decidedProposalCount = new Set(proposed.map(keyOf).filter((key) => !pending.has(key))).size;
      return Response.json({ receipts, pendingProposals, decidedProposalCount });
    },
    getMemoryVectorStats: () => Response.json({ vector: context.memoryRegistry.vectorStats() }),
    getMemoryReviewQueue: async (url) => {
      const limit = readBoundedPositiveInteger(url.searchParams.get('limit'), 10, 1_000);
      const rawScope = url.searchParams.get('scope');
      if (rawScope !== null && rawScope !== 'session' && rawScope !== 'project' && rawScope !== 'team') {
        return jsonErrorResponse({ error: `Invalid scope: ${rawScope}. Allowed: session, project, team` }, { status: 400 });
      }
      const scope = rawScope ?? undefined;
      return Response.json({ records: await context.memoryRegistry.reviewQueue(limit, scope) });
    },
    postMemoryVectorRebuild: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json({ vector: await context.memoryRegistry.rebuildVectorsAsync() });
    },
    postMemoryEmbeddingDefault: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.embeddingDefault.parse(body);
      if (input instanceof Response) return input;
      try {
        context.memoryEmbeddingRegistry.setDefaultProvider(input.providerId);
        return Response.json(await context.memoryRegistry.doctor());
      } catch (error) {
        return readServiceErrorResponse(error);
      }
    },
    // Canonical-store record CRUD/search. The daemon is the single writer; a client
    // surface reaches its store ONLY through these routes and never opens the file.
    // Writes are admin-only, like the gateway verbs for the same operations: the
    // daemon gate only proves the caller holds some valid credential.
    postMemoryRecordAdd: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const parsed = parseMemoryRecordAddBody(body);
      if (parsed instanceof Response) return parsed;
      const input = parsed.review ? { ...parsed, review: withAuthenticatedReviewer(context, req, parsed.review) } : parsed;
      try {
        const record = await context.memoryRegistry.add(input);
        return Response.json({ record }, { status: 201 });
      } catch (error) {
        return readServiceErrorResponse(error);
      }
    },
    postMemoryRecordSearch: async (req) => {
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const parsed = parseMemoryRecordSearchBody(body);
      if (parsed instanceof Response) return parsed;
      return Response.json(await context.memoryRegistry.honestSearch(parsed.filter, { recall: parsed.recall }));
    },
    getMemoryRecord: (id) => {
      const record = context.memoryRegistry.get(id);
      return record
        ? Response.json({ record })
        : jsonErrorResponse({ error: 'Unknown memory record', code: MEMORY_RECORD_NOT_FOUND_CODE }, { status: 404 });
    },
    postMemoryRecordReview: async (id, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const parsed = parseMemoryRecordReviewBody(body);
      if (parsed instanceof Response) return parsed;
      const patch = withAuthenticatedReviewer(context, req, parsed);
      try {
        const record = context.memoryRegistry.review(id, patch);
        return record
          ? Response.json({ record })
          : jsonErrorResponse({ error: 'Unknown memory record', code: MEMORY_RECORD_NOT_FOUND_CODE }, { status: 404 });
      } catch (error) {
        return readServiceErrorResponse(error);
      }
    },
    // `{ deleted: false }` for an unknown id is the documented answer (see memory.records.delete).
    deleteMemoryRecord: (id, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      try {
        const deleted = context.memoryRegistry.delete(id);
        return Response.json({ id, deleted });
      } catch (error) {
        return readServiceErrorResponse(error);
      }
    },
    // Full-detach catalog (1.2.0). Reads serialize a bare array/entity; writes route
    // through the single-writer registry exactly like add/review/delete above.
    postMemoryRecordList: async (req) => {
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const filter = parseMemoryRecordFilterBody(body);
      if (filter instanceof Response) return filter;
      return Response.json({ records: await context.memoryRegistry.search(filter) });
    },
    postMemoryRecordSearchSemantic: async (req) => {
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const filter = parseMemoryRecordFilterBody(body);
      if (filter instanceof Response) return filter;
      return Response.json({ results: await context.memoryRegistry.searchSemantic(filter) });
    },
    postMemoryRecordUpdate: async (id, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const patch = parseMemoryRecordUpdateBody(body);
      if (patch instanceof Response) return patch;
      try {
        const record = context.memoryRegistry.update(id, patch);
        return record
          ? Response.json({ record })
          : jsonErrorResponse({ error: 'Unknown memory record', code: MEMORY_RECORD_NOT_FOUND_CODE }, { status: 404 });
      } catch (error) {
        return readServiceErrorResponse(error);
      }
    },
    getMemoryRecordLinks: (id) => {
      if (context.memoryRegistry.get(id) === null) {
        return jsonErrorResponse({ error: 'Unknown memory record', code: MEMORY_RECORD_NOT_FOUND_CODE }, { status: 404 });
      }
      return Response.json({ links: context.memoryRegistry.linksFor(id) });
    },
    postMemoryRecordLink: async (id, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = parseMemoryLinkBody(body);
      if (input instanceof Response) return input;
      try {
        const link = await context.memoryRegistry.link(id, input.toId, input.relation);
        // link() returns null when either endpoint id is unknown, an honest 404, not a
        // 200 that pretends a link was made between records that do not both exist.
        return link
          ? Response.json({ link }, { status: 201 })
          : jsonErrorResponse({ error: 'Unknown memory record (link source or target)', code: MEMORY_RECORD_NOT_FOUND_CODE }, { status: 404 });
      } catch (error) {
        return readServiceErrorResponse(error);
      }
    },
    postMemoryRecordExport: async (req) => {
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const filter = parseMemoryRecordFilterBody(body);
      if (filter instanceof Response) return filter;
      return Response.json({ bundle: context.memoryRegistry.exportBundle(filter) });
    },
    postMemoryRecordImport: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = parseMemoryBundleImportBody(body);
      if (input instanceof Response) return input;
      try {
        return Response.json({ result: await context.memoryRegistry.importBundle(input.bundle) });
      } catch (error) {
        return readServiceErrorResponse(error);
      }
    },
    getLocalAuth: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getLocalAuthSnapshot()));
    },
    postLocalAuthUser: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.localAuthUser.parse(body);
      if (input instanceof Response) return input;
      try {
        return Response.json({ user: context.userAuth.addUser(input.username, input.password, input.roles, input.scopes) }, { status: 201 });
      } catch (error) {
        return readServiceErrorResponse(error, { fallbackStatus: 400 });
      }
    },
    deleteLocalAuthUser: (username, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      try {
        const removed = context.userAuth.deleteUser(username);
        return removed
          ? Response.json({ deleted: true })
          : jsonErrorResponse({ error: 'Unknown user' }, { status: 404 });
      } catch (error) {
        return readServiceErrorResponse(error, { fallbackStatus: 400 });
      }
    },
    postLocalAuthPassword: async (username, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.localAuthPassword.parse(body);
      if (input instanceof Response) return input;
      try {
        context.userAuth.rotatePassword(username, input.password);
        return Response.json({ rotated: true });
      } catch (error) {
        return readServiceErrorResponse(error, { fallbackStatus: 400 });
      }
    },
    postLocalAuthUserScopes: async (username, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.localAuthScopes.parse(body);
      if (input instanceof Response) return input;
      try {
        return Response.json({ user: context.userAuth.setUserScopes(username, input.scopes) });
      } catch (error) {
        return readServiceErrorResponse(error, { fallbackStatus: 400 });
      }
    },
    deleteLocalAuthSession: (sessionId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return context.userAuth.revokeSession(sessionId)
        ? Response.json({ revoked: true })
        : jsonErrorResponse({ error: 'Unknown session' }, { status: 404 });
    },
    deleteBootstrapFile: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json({ removed: context.userAuth.clearBootstrapCredentialFile() });
    },
    getPanels: () => withHelpers(context.integrationHelpers, (helpers) => Response.json({ panels: helpers.listPanels() })),
    postPanelOpen: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = integrationBodySchemas.panelOpen.parse(body);
      if (input instanceof Response) return input;
      const helpers = context.integrationHelpers;
      const listed = helpers?.listPanels().some((panel) => (panel as { id?: unknown }).id === input.panelId) ?? false;
      if (!listed) return jsonErrorResponse({ error: `Unknown panel: ${input.panelId}` }, { status: 404 });
      // A listed view the terminal did not show is not reported as opened.
      return helpers?.openPanel(input.panelId, input.pane)
        ? Response.json({ opened: true, id: input.panelId, pane: input.pane })
        : jsonErrorResponse({
          error: `Panel '${input.panelId}' is listed but did not open: this process has no terminal screen showing views. Open it from a running terminal session, then check GET /api/panels.`,
        }, { status: 409 });
    },
  };
}

function withHelpers<T>(
  helpers: IntegrationHelperServiceLike | null | undefined,
  run: (helpers: IntegrationHelperServiceLike) => T,
): T | Response {
  if (!helpers) {
    return jsonErrorResponse({ error: 'Integration helper service unavailable' }, { status: 503 });
  }
  return run(helpers);
}

/**
 * Handle GET /api/sessions.
 *
 * Returns the session broker snapshot from the integration helper service.
 * Pagination (`?limit=` / `?cursor=`) is not supported on this endpoint,
 * `IntegrationHelperServiceLike` is a consumer-supplied structural interface
 * whose concrete implementation lives outside daemon-api and cannot be
 * range-queried here.  Requests containing pagination params receive the
 * same snapshot response as non-paginated requests (backward compatible).
 */
function handleGetIntegrationSessions(
  helpers: IntegrationHelperServiceLike | null | undefined,
  _url: URL | undefined,
): Response {
  if (!helpers) {
    return jsonErrorResponse({ error: 'Integration helper service unavailable' }, { status: 503 });
  }
  return Response.json(helpers.getSessionBrokerSnapshot());
}

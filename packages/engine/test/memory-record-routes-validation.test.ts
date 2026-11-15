/**
 * The daemon's memory record routes: what a body must look like before it
 * reaches the store, who may write, and which status a store failure gets.
 * The store writes `scope` and review state as given and reads them back
 * strictly, so one record with a value outside the closed set would make every
 * later read fail.
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonIntegrationRouteHandlers } from '../daemon-api/src/integration-routes.js';
import {
  parseMemoryRecordAddBody,
  parseMemoryRecordFilterBody,
  parseMemoryRecordReviewBody,
  parseMemoryRecordUpdateBody,
} from '../daemon-api/src/memory-record-body.js';
import type { DaemonIntegrationRouteContext, MemoryRecordAddInput, MemoryRegistryLike } from '../daemon-api/src/integration-route-types.js';
import { assertValidMemoryBundle, assertValidMemoryFields } from '../platform/src/platform/state/memory-store-helpers.js';

type Json = Record<string, unknown>;

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

describe('memory record body parsers', () => {
  test('a scope outside session, project and team is refused before it reaches the store', async () => {
    const result = parseMemoryRecordAddBody({ cls: 'note', summary: 'x', scope: 'workspace' });
    expect(isResponse(result)).toBe(true);
    expect((result as Response).status).toBe(400);
    expect(String(((await (result as Response).json()) as Json).error)).toContain('scope');
  });

  test('a review state outside the four is refused, on add and on review', () => {
    expect(isResponse(parseMemoryRecordAddBody({ cls: 'note', summary: 'x', review: { state: 'maybe' } }))).toBe(true);
    expect(isResponse(parseMemoryRecordReviewBody({ state: 'maybe' }))).toBe(true);
    expect(parseMemoryRecordReviewBody({ state: 'reviewed', confidence: 80 })).toEqual({ state: 'reviewed', confidence: 80 });
  });

  test('a valid add keeps every field and any class name', () => {
    expect(parseMemoryRecordAddBody({ cls: 'custom-class', summary: 'x', scope: 'team', tags: ['a'] }))
      .toEqual({ cls: 'custom-class', summary: 'x', scope: 'team', tags: ['a'] });
  });

  test('a scalar review state filters to that state instead of widening to all of them', () => {
    expect(parseMemoryRecordFilterBody({ reviewState: 'stale', scope: 'project' })).toEqual({ reviewState: ['stale'], scope: 'project' });
    expect(parseMemoryRecordFilterBody({ reviewState: ['stale', 'contradicted'] })).toEqual({ reviewState: ['stale', 'contradicted'] });
  });

  test('a filter field of the wrong type is a 400, never a wider result', () => {
    for (const body of [{ limit: '10' }, { tags: 'a' }, { since: '5' }, { semantic: 'yes' }, { reviewState: 'archived' }, { scope: 'workspace' }]) {
      const result = parseMemoryRecordFilterBody(body);
      expect(isResponse(result)).toBe(true);
      expect((result as Response).status).toBe(400);
    }
  });

  test('a negative or fractional limit is refused because slice(0, -1) would keep all but the last record', () => {
    expect(isResponse(parseMemoryRecordFilterBody({ limit: -1 }))).toBe(true);
    expect(isResponse(parseMemoryRecordFilterBody({ limit: 1.5 }))).toBe(true);
    expect(parseMemoryRecordFilterBody({ limit: 0 })).toEqual({ limit: 0 });
    expect(parseMemoryRecordFilterBody({ limit: 25 })).toEqual({ limit: 25 });
  });

  test('null means "not supplied" so a client that sends nulls for unset fields keeps working', () => {
    expect(parseMemoryRecordFilterBody({ scope: null, limit: null, tags: null })).toEqual({});
  });

  test('an update with an empty tag list clears the tags, and an absent list leaves them alone', () => {
    expect(parseMemoryRecordUpdateBody({ tags: [] })).toEqual({ tags: [] });
    expect(parseMemoryRecordUpdateBody({ summary: 'new' })).toEqual({ summary: 'new' });
  });

  test('an update window bound must be a number or null', () => {
    expect(parseMemoryRecordUpdateBody({ validFrom: 5, validUntil: null })).toEqual({ validFrom: 5, validUntil: null });
    expect(isResponse(parseMemoryRecordUpdateBody({ validFrom: '5' }))).toBe(true);
  });
});

interface RegistryCalls {
  add: number;
  review: number;
  update: number;
  delete: number;
  link: number;
  importBundle: number;
}

function integrationContext(options: {
  readonly admin?: boolean;
  readonly registry?: Partial<MemoryRegistryLike>;
  readonly userAuth?: Partial<DaemonIntegrationRouteContext['userAuth']>;
  readonly consolidation?: DaemonIntegrationRouteContext['memoryConsolidation'];
} = {}): { readonly context: DaemonIntegrationRouteContext; readonly calls: RegistryCalls; readonly addedUsers: Array<readonly string[]> } {
  const calls: RegistryCalls = { add: 0, review: 0, update: 0, delete: 0, link: 0, importBundle: 0 };
  const addedUsers: Array<readonly string[]> = [];
  const registry = {
    doctor: async () => ({}),
    vectorStats: () => ({}),
    rebuildVectorsAsync: async () => ({}),
    reviewQueue: async () => [],
    add: async () => { calls.add += 1; return { id: 'm1' }; },
    honestSearch: async () => ({ records: [] }),
    get: () => ({ id: 'm1', reviewState: 'fresh' }),
    review: () => { calls.review += 1; return { id: 'm1' }; },
    delete: () => { calls.delete += 1; return true; },
    search: async () => [],
    searchSemantic: async () => [],
    update: () => { calls.update += 1; return { id: 'm1' }; },
    link: async () => { calls.link += 1; return { id: 'l1' }; },
    linksFor: () => [],
    exportBundle: () => ({}),
    importBundle: async () => { calls.importBundle += 1; return {}; },
    ...options.registry,
  } as MemoryRegistryLike;
  const context = {
    channelPlugins: {},
    integrationHelpers: null,
    memoryEmbeddingRegistry: { setDefaultProvider: () => undefined },
    memoryRegistry: registry,
    memoryConsolidation: options.consolidation,
    parseJsonBody: async (req: Request) => await req.json() as Json,
    providerRuntime: {},
    requireAdmin: () => (options.admin === false ? new Response('Denied', { status: 403 }) : null),
    userAuth: {
      addUser: (_username: string, _password: string, roles: readonly string[]) => { addedUsers.push(roles); return { username: 'u' }; },
      deleteUser: () => true,
      rotatePassword: () => undefined,
      revokeSession: () => true,
      clearBootstrapCredentialFile: () => false,
      ...options.userAuth,
    },
  } as unknown as DaemonIntegrationRouteContext;
  return { context, calls, addedUsers };
}

function post(body: Json): Request {
  return new Request('http://daemon.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('memory record writes need an admin', () => {
  test('a caller that is not an admin cannot add, review, update, link, delete, import or open a panel', async () => {
    const { context, calls } = integrationContext({ admin: false });
    const handlers = createDaemonIntegrationRouteHandlers(context);
    const responses = await Promise.all([
      handlers.postMemoryRecordAdd(post({ cls: 'note', summary: 'x' })),
      handlers.postMemoryRecordReview('m1', post({ state: 'reviewed' })),
      handlers.postMemoryRecordUpdate('m1', post({ summary: 'y' })),
      handlers.postMemoryRecordLink('m1', post({ toId: 'm2', relation: 'related' })),
      handlers.deleteMemoryRecord('m1', post({})),
      handlers.postMemoryRecordImport(post({ bundle: { records: [] } })),
      handlers.postPanelOpen(post({ id: 'panel' })),
      handlers.getSecuritySettings(post({})),
      handlers.getSettings(post({})),
    ]);
    expect(responses.map((response) => (response as Response).status)).toEqual(Array(9).fill(403));
    expect(calls).toEqual({ add: 0, review: 0, update: 0, delete: 0, link: 0, importBundle: 0 });
  });

  test('an admin still adds a record', async () => {
    const { context, calls } = integrationContext();
    const response = await createDaemonIntegrationRouteHandlers(context).postMemoryRecordAdd(post({ cls: 'note', summary: 'x', scope: 'project' }));
    expect((response as Response).status).toBe(201);
    expect(calls.add).toBe(1);
  });
});

describe('a store failure keeps its own meaning on the wire', () => {
  test('a write that fails on disk is a 5xx, not a 400', async () => {
    const { context } = integrationContext({ registry: { add: async () => { throw new Error('SQLITE_FULL'); } } });
    const response = await createDaemonIntegrationRouteHandlers(context).postMemoryRecordAdd(post({ cls: 'note', summary: 'x' }));
    expect((response as Response).status).toBeGreaterThanOrEqual(500);
  });

  test('a stale image is retryable on every write route, with the same status and a JSON body', async () => {
    const stale = () => Object.assign(new Error('Memory file changed on disk; retry the operation.'), { retryable: true });
    const { context } = integrationContext({
      registry: {
        add: async () => { throw stale(); },
        review: () => { throw stale(); },
        update: () => { throw stale(); },
        delete: () => { throw stale(); },
        link: async () => { throw stale(); },
        importBundle: async () => { throw stale(); },
      },
    });
    const handlers = createDaemonIntegrationRouteHandlers(context);
    const responses = await Promise.all([
      handlers.postMemoryRecordAdd(post({ cls: 'note', summary: 'x' })),
      handlers.postMemoryRecordReview('m1', post({ state: 'reviewed' })),
      handlers.postMemoryRecordUpdate('m1', post({ summary: 'y' })),
      handlers.postMemoryRecordLink('m1', post({ toId: 'm2', relation: 'related' })),
      handlers.deleteMemoryRecord('m1', post({})),
      handlers.postMemoryRecordImport(post({ bundle: { records: [] } })),
    ]);
    for (const response of responses) {
      expect((response as Response).status).toBe(503);
      expect(String(((await (response as Response).json()) as Json).error)).toContain('retry');
    }
  });

  test('deleting an unknown id stays the documented 200 with deleted:false', async () => {
    const { context } = integrationContext({ registry: { delete: () => false } });
    const response = await createDaemonIntegrationRouteHandlers(context).deleteMemoryRecord('ghost', post({})) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'ghost', deleted: false });
  });
});

describe('creating a local user', () => {
  test('omitting roles creates an admin, as before', async () => {
    const { context, addedUsers } = integrationContext();
    const response = await createDaemonIntegrationRouteHandlers(context).postLocalAuthUser(post({ username: 'u', password: 'p' })) as Response;
    expect(response.status).toBe(201);
    expect(addedUsers).toEqual([['admin']]);
  });

  test('roles that are present but empty or malformed are refused instead of becoming admin', async () => {
    const { context, addedUsers } = integrationContext();
    const handlers = createDaemonIntegrationRouteHandlers(context);
    for (const roles of [[], 'viewer', [1], [''], null]) {
      const response = await handlers.postLocalAuthUser(post({ username: 'u', password: 'p', roles })) as Response;
      expect(response.status).toBe(400);
    }
    expect(addedUsers).toEqual([]);
  });

  test('a named role is passed through', async () => {
    const { context, addedUsers } = integrationContext();
    await createDaemonIntegrationRouteHandlers(context).postLocalAuthUser(post({ username: 'u', password: 'p', roles: ['viewer'] }));
    expect(addedUsers).toEqual([['viewer']]);
  });
});

describe('consolidation receipts', () => {
  test('a proposal whose records were all reviewed or removed is no longer pending', async () => {
    const receipts = [{ proposed: [
      { kind: 'contradiction', ids: ['reviewed-one'], route: 'r', reason: 'x' },
      { kind: 'stale-delete', ids: ['gone'], route: 'r', reason: 'x' },
      { kind: 'contradiction', ids: ['open-one'], route: 'r', reason: 'x' },
    ] }];
    const { context } = integrationContext({
      consolidation: { listReceipts: () => receipts },
      registry: {
        get: (id: string) => (id === 'gone' ? null : { id, reviewState: id === 'reviewed-one' ? 'reviewed' : 'stale' }),
      },
    });
    const response = await createDaemonIntegrationRouteHandlers(context).getMemoryConsolidationReceipts() as Response;
    const body = await response.json() as { pendingProposals: Array<{ ids: string[] }>; decidedProposalCount: number };
    expect(body.pendingProposals.map((proposal) => proposal.ids[0])).toEqual(['open-one']);
    expect(body.decidedProposalCount).toBe(2);
  });
});

describe('a memory review is recorded under the credential that made it', () => {
  function withPrincipal(context: DaemonIntegrationRouteContext, principalId: string | null): DaemonIntegrationRouteContext {
    return { ...context, resolveAuthenticatedPrincipal: () => (principalId ? { principalId } : null) };
  }

  test('a reviewedBy in the review body cannot name another reviewer', async () => {
    const patches: Json[] = [];
    const { context } = integrationContext({ registry: { review: (_id: string, patch: Json) => { patches.push(patch); return { id: 'm1' }; } } as Partial<MemoryRegistryLike> });
    const handlers = createDaemonIntegrationRouteHandlers(withPrincipal(context, 'token-admin'));
    const response = await handlers.postMemoryRecordReview('m1', post({ state: 'reviewed', reviewedBy: 'owner' })) as Response;
    expect(response.status).toBe(200);
    expect(patches).toEqual([{ state: 'reviewed', reviewedBy: 'token-admin' }]);
  });

  test('the same holds for the review block of an add, and with no resolvable principal the claim is dropped', async () => {
    const added: MemoryRecordAddInput[] = [];
    const { context } = integrationContext({ registry: { add: async (input: MemoryRecordAddInput) => { added.push(input); return { id: 'm1' }; } } });
    await createDaemonIntegrationRouteHandlers(withPrincipal(context, 'token-admin'))
      .postMemoryRecordAdd(post({ cls: 'decision', summary: 'x', review: { state: 'reviewed', reviewedBy: 'owner' } }));
    await createDaemonIntegrationRouteHandlers(withPrincipal(context, null))
      .postMemoryRecordAdd(post({ cls: 'decision', summary: 'x', review: { state: 'reviewed', reviewedBy: 'owner' } }));
    expect(added[0]?.review?.reviewedBy).toBe('token-admin');
    expect(added[1]?.review?.reviewedBy).toBeUndefined();
  });
});

describe('a record the store refuses for its content is the caller\'s 400', () => {
  test('an unknown class and an over-long summary answer 400 through the route', async () => {
    const { context } = integrationContext({ registry: { add: async (input: MemoryRecordAddInput) => { assertValidMemoryFields(input); return { id: 'm1' }; } } });
    const handlers = createDaemonIntegrationRouteHandlers(context);
    const badClass = await handlers.postMemoryRecordAdd(post({ cls: 'note', summary: 'x' })) as Response;
    expect(badClass.status).toBe(400);
    expect(String(((await badClass.json()) as Json).error)).toContain('cls');
    const tooLong = await handlers.postMemoryRecordAdd(post({ cls: 'decision', summary: 'x'.repeat(100_000) })) as Response;
    expect(tooLong.status).toBe(400);
  });

  test('a malformed import bundle answers 400 through the route, not a server error', async () => {
    const { context } = integrationContext({ registry: { importBundle: async (bundle: unknown) => { assertValidMemoryBundle(bundle); return { imported: 0 }; } } as unknown as Partial<MemoryRegistryLike> });
    const handlers = createDaemonIntegrationRouteHandlers(context);
    const noId = await handlers.postMemoryRecordImport(post({ bundle: { records: [{}], links: [] } })) as Response;
    expect(noId.status).toBe(400);
    const badTime = await handlers.postMemoryRecordImport(post({ bundle: { records: [{ id: 'a', cls: 'decision', summary: 's', createdAt: 'n', updatedAt: 1 }], links: [] } })) as Response;
    expect(badTime.status).toBe(400);
  });
});

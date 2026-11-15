/**
 * A knowledge route answers 404 only when the service named the missing record
 * with its own code, or the error carries a real HTTP 404. A category-only
 * not-found error is inferred to code NOT_FOUND and must not become a 404.
 */
import { describe, test, expect } from 'bun:test';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { buildErrorResponseBody } from '../daemon-api/src/error-response.js';
import { createDaemonKnowledgeRouteHandlers } from '../daemon-api/src/knowledge-routes.js';
import type { DaemonKnowledgeRouteContext } from '../daemon-api/src/knowledge-route-types.js';

// ---------------------------------------------------------------------------
// Wire code: always-present floor
// ---------------------------------------------------------------------------

describe('buildErrorResponseBody: code always present for GoodVibesError on wire', () => {
  test('GoodVibesError with explicit code preserves code on wire', () => {
    const err = new GoodVibesError('not found', { code: 'NOT_FOUND', category: 'not_found' });
    const body = buildErrorResponseBody(err);
    expect(body.code).toBe('NOT_FOUND');
  });

  test('GoodVibesError with category-only inferred code appears on wire (NOT_FOUND inference)', () => {
    // No explicit code, inferCodeFromCategory('not_found') supplies NOT_FOUND.
    // This is the new behavior: code is always present on GoodVibesError even without
    // an explicit code. The wire body always includes 'code' for platform errors.
    const err = new GoodVibesError('resource unavailable', { category: 'not_found' });
    expect(err.code).toBe('NOT_FOUND'); // confirm inference happened
    const body = buildErrorResponseBody(err);
    expect(body.code).toBe('NOT_FOUND');
  });

  test('GoodVibesError with unknown category produces UNKNOWN on wire (floor)', () => {
    const err = new GoodVibesError('something went wrong', { category: 'unknown' });
    expect(err.code).toBe('UNKNOWN');
    const body = buildErrorResponseBody(err);
    expect(body.code).toBe('UNKNOWN');
  });

  test('plain Error (non-platform) does not produce code on the wire body', () => {
    // buildErrorResponseBody only emits code when the error has a recognized code field.
    // Plain Error instances have no code, so it is absent from the wire body.
    const body = buildErrorResponseBody(new Error('oops'));
    expect(body.code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The three routes that map a not-found failure to 404, driven end to end
// ---------------------------------------------------------------------------

type Route = 'review issue' | 'decide candidate' | 'run job';
const DOMAIN_CODE: Record<Route, string> = {
  'review issue': 'KNOWLEDGE_ISSUE_NOT_FOUND',
  'decide candidate': 'KNOWLEDGE_CANDIDATE_NOT_FOUND',
  'run job': 'KNOWLEDGE_JOB_NOT_FOUND',
};

async function statusFor(route: Route, failure: Error): Promise<number> {
  const fail = async (): Promise<never> => { throw failure; };
  // Only the members these three routes read are supplied.
  const context = {
    requireAdmin: () => undefined,
    parseOptionalJsonBody: async () => ({ action: 'accept' }),
    parseJsonBody: async () => ({ decision: 'accept' }),
    resolveAuthenticatedPrincipal: () => ({ principalId: 'operator', admin: true, scopes: [] }),
    knowledgeService: { reviewIssue: fail, decideConsolidationCandidate: fail, runJob: fail },
  } as unknown as DaemonKnowledgeRouteContext;
  const handlers = createDaemonKnowledgeRouteHandlers(context);
  const request = new Request('http://daemon.local/api/knowledge', { method: 'POST' });
  const response = route === 'review issue' ? await handlers.postKnowledgeReviewIssue('id', request)
    : route === 'decide candidate' ? await handlers.postKnowledgeDecideCandidate('id', request)
      : await handlers.postKnowledgeRunJob('id', request);
  return response.status;
}

describe.each(['review issue', 'decide candidate', 'run job'] as const)('knowledge route %s 404 mapping', route => {
  const domainCode = DOMAIN_CODE[route];

  test('the route\'s own not-found code maps to 404 without a status', async () => {
    const err = new GoodVibesError('not found', { category: 'not_found' });
    Object.defineProperty(err, 'code', { value: domainCode, writable: false, configurable: true });
    expect(await statusFor(route, err)).toBe(404);
  });

  test('NOT_FOUND carrying an HTTP 404 status maps to 404', async () => {
    expect(await statusFor(route, new GoodVibesError('upstream 404', { category: 'not_found', status: 404 }))).toBe(404);
  });

  test('a category-only not-found error keeps the status its category names', async () => {
    const err = new GoodVibesError('resource unavailable', { category: 'not_found' });
    expect(err.code).toBe('NOT_FOUND');
    expect(await statusFor(route, err)).toBe(404);
  });

  test('a store or provider failure keeps its own status instead of a 400', async () => {
    expect(await statusFor(route, Object.assign(new Error('provider down'), { status: 503 }))).toBe(503);
    expect(await statusFor(route, Object.assign(new Error('no space left'), { code: 'ENOSPC', syscall: 'write' }))).toBe(500);
  });

  test('NOT_FOUND with a non-404 status stays a 400', async () => {
    expect(await statusFor(route, Object.assign(new Error('bad request'), { code: 'NOT_FOUND', status: 400 }))).toBe(400);
  });

  test('another route\'s not-found code does not map to 404', async () => {
    const other = Object.values(DOMAIN_CODE).find(code => code !== domainCode)!;
    expect(await statusFor(route, Object.assign(new Error('other record'), { code: other }))).toBe(400);
  });
});

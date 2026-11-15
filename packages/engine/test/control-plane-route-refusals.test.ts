/**
 * A decision or report that changed nothing must say so: an approval acted on
 * after it ended reports `applied: false` with the reason (the web turns that
 * into "nothing changed" instead of "Approved"), and a surface reporting
 * delivery of an input that already ended is refused with its actual state.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonSystemRouteHandlers } from '../daemon-api/src/system-routes.js';
import type { DaemonSystemRouteContext } from '../daemon-api/src/system-route-types.js';
import { createDaemonRuntimeSessionRouteHandlers } from '../daemon-api/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/runtime-route-types.js';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.js';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.js';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'control-plane-refusals-')); roots.push(dir); return dir;
}
const REQUEST: PermissionPromptRequest = { callId: 'call-1', tool: 'exec', args: { command: 'ls' }, category: 'execute',
  analysis: { classification: 'exec', riskLevel: 'medium', summary: 'list files', reasons: [] } };
const post = (body: Record<string, unknown> = {}) => new Request('http://local/fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function approvalRoutes(broker: ApprovalBroker) {
  return createDaemonSystemRouteHandlers({
    approvalBroker: broker, parseOptionalJsonBody: (request: Request) => request.json(),
    requireAdmin: () => null,
    requireAuthenticatedSession: () => ({ username: 'web-user', roles: ['admin'] }),
    recordApiResponse: (_request: Request, _path: string, response: Response) => response,
  } as unknown as DaemonSystemRouteContext);
}

test('approving an approval that already expired answers applied:false with the reason', async () => {
  const broker = new ApprovalBroker({ storePath: join(root(), 'approvals.json') });
  const raised = await broker.raiseApproval({ request: REQUEST, timeoutMs: 1 });
  await raised.decision;
  const response = await approvalRoutes(broker).approvalAction(raised.approval.id, 'approve', post());
  expect(response.status).toBe(200);
  const body = await response.json() as { applied: boolean; refusal?: string; approval: { status: string } };
  expect(body.approval.status).toBe('expired');
  expect(body.applied).toBe(false);
  expect(body.refusal).toContain('expired');
  expect(body.refusal).toContain('cannot become approved');
});

test('an approval this call decided answers applied:true', async () => {
  const broker = new ApprovalBroker({ storePath: join(root(), 'approvals.json') });
  const raised = await broker.raiseApproval({ request: REQUEST });
  const response = await approvalRoutes(broker).approvalAction(raised.approval.id, 'deny', post({ reason: 'not now' }));
  const body = await response.json() as { applied: boolean; refusal?: string };
  expect(body).toMatchObject({ applied: true });
  expect(body.refusal).toBeUndefined();
  await raised.decision;
});

test('a surface reporting delivery of a cancelled input is refused with the state it is in', async () => {
  const broker = new SharedSessionBroker({
    storePath: join(root(), 'sessions.json'),
    routeBindings: { start: async () => {}, getBinding: () => null, resolve: () => null, patchBinding: async () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  });
  try {
    await broker.createSession({ id: 's1' });
    const submitted = await broker.submitMessage({ sessionId: 's1', surfaceKind: 'web', surfaceId: 'surface:web', body: 'hello' });
    await broker.cancelInput('s1', submitted.input.id);
    let answered = 0;
    const handlers = createDaemonRuntimeSessionRouteHandlers({
      sessionBroker: broker, requireAdmin: () => null,
      parseOptionalJsonBody: (request: Request) => request.json(),
      recordApiResponse: (_request: Request, _path: string, response: Response) => response,
      completeSurfaceReplyFromSurface: async () => { answered += 1; },
    } as unknown as DaemonRuntimeRouteContext);
    const response = await handlers.deliverSharedSessionInput('s1', submitted.input.id, post({ consumed: true, agentId: 'tui-agent', answer: 'done' }));
    expect(response.status).toBe(409);
    const body = await response.json() as { code: string; error: string; input: { state: string } };
    expect(body.code).toBe('INPUT_NOT_DELIVERABLE');
    expect(body.error).toContain('it is cancelled');
    expect(body.input.state).toBe('cancelled');
    expect(answered).toBe(0);
  } finally { await broker.stop(); }
});

test('two callers sharing one actor name cannot both read applied:true for one decision', async () => {
  const broker = new ApprovalBroker({ storePath: join(root(), 'approvals.json') });
  const raised = await broker.raiseApproval({ request: REQUEST });
  const routes = approvalRoutes(broker);
  const [first, second] = await Promise.all([
    routes.approvalAction(raised.approval.id, 'approve', post()),
    routes.approvalAction(raised.approval.id, 'approve', post()),
  ]);
  const bodies = await Promise.all([first, second].map(response => response.json() as Promise<{ applied: boolean; refusal?: string }>));
  expect(bodies.filter(body => body.applied)).toHaveLength(1);
  expect(bodies.find(body => !body.applied)?.refusal).toContain('final');
});

test('a surface releasing its claim on a shared ask leaves it pending for the surface still waiting', async () => {
  const broker = new ApprovalBroker({ storePath: join(root(), 'approvals.json') });
  const metadata = { raisedVia: 'approvals.raise' };
  const creator = await broker.raiseApproval({ request: REQUEST, metadata });
  const joiner = await broker.raiseApproval({ request: REQUEST, metadata });
  expect(joiner.coalesced).toBe(true);
  const routes = approvalRoutes(broker);
  const first = await (await routes.approvalAction(creator.approval.id, 'cancel', post({ release: true }))).json() as { applied: boolean; approval: { status: string } };
  expect(first).toMatchObject({ applied: false, approval: { status: 'pending' } });
  const last = await (await routes.approvalAction(creator.approval.id, 'cancel', post({ release: true }))).json() as { applied: boolean; approval: { status: string } };
  expect(last).toMatchObject({ applied: true, approval: { status: 'cancelled' } });
  expect(await joiner.decision).toMatchObject({ approved: false });
});

test('a plain cancel still cancels a shared ask outright', async () => {
  const broker = new ApprovalBroker({ storePath: join(root(), 'approvals.json') });
  const metadata = { raisedVia: 'approvals.raise' };
  const creator = await broker.raiseApproval({ request: REQUEST, metadata });
  await broker.raiseApproval({ request: REQUEST, metadata });
  const body = await (await approvalRoutes(broker).approvalAction(creator.approval.id, 'cancel', post())).json() as { applied: boolean; approval: { status: string } };
  expect(body).toMatchObject({ applied: true, approval: { status: 'cancelled' } });
});

test('a release retried with the same holdId does not give up the other surface\'s hold', async () => {
  const broker = new ApprovalBroker({ storePath: join(root(), 'approvals.json') });
  const metadata = { raisedVia: 'approvals.raise' };
  const creator = await broker.raiseApproval({ request: REQUEST, metadata });
  const joiner = await broker.raiseApproval({ request: REQUEST, metadata });
  const routes = approvalRoutes(broker);
  const release = async () => await (await routes.approvalAction(creator.approval.id, 'cancel', post({ release: true, holdId: creator.holdId }))).json() as { applied: boolean; approval: { status: string } };
  expect(await release()).toMatchObject({ applied: false, approval: { status: 'pending' } });
  // The transport retried the same release: the joiner's hold must survive it.
  expect(await release()).toMatchObject({ applied: false, approval: { status: 'pending' } });
  const last = await (await routes.approvalAction(creator.approval.id, 'cancel', post({ release: true, holdId: joiner.holdId }))).json() as { applied: boolean; approval: { status: string } };
  expect(last).toMatchObject({ applied: true, approval: { status: 'cancelled' } });
});

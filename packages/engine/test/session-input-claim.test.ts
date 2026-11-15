/**
 * Two processes hosting one session must not both start an agent for one
 * message: the daemon grants a claim to a single caller, and the dispatcher
 * starts nothing it was refused.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonRuntimeSessionRouteHandlers } from '../daemon-api/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/runtime-route-types.js';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.js';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.js';
import { createWireSessionDispatch } from '../platform/src/platform/runtime/client/session-dispatch.ts';
import type { SessionInputsWireClient } from '../platform/src/platform/runtime/client/session-dispatch.ts';

const quiet = { debug: () => {}, info: () => {}, warn: () => {} };
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const post = (body: Record<string, unknown> = {}) => new Request('http://local/fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function withDaemon(run: (deliver: (inputId: string, body: Record<string, unknown>) => Promise<Response>, inputId: string, broker: SharedSessionBroker) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'session-input-claim-'));
  roots.push(dir);
  const broker = new SharedSessionBroker({
    storePath: join(dir, 'sessions.json'),
    routeBindings: { start: async () => {}, getBinding: () => null, resolve: () => null, patchBinding: async () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  });
  try {
    await broker.createSession({ id: 's1' });
    const submitted = await broker.submitMessage({ sessionId: 's1', surfaceKind: 'web', surfaceId: 'surface:web', body: 'hello' });
    const handlers = createDaemonRuntimeSessionRouteHandlers({
      sessionBroker: broker, requireAdmin: () => null,
      parseOptionalJsonBody: (request: Request) => request.json(),
      recordApiResponse: (_request: Request, _path: string, response: Response) => response,
      completeSurfaceReplyFromSurface: async () => {},
    } as unknown as DaemonRuntimeRouteContext);
    await run(async (inputId, body) => await handlers.deliverSharedSessionInput('s1', inputId, post(body)), submitted.input.id, broker);
  } finally { await broker.stop(); }
}

test('only the first of two claims on one input is granted, and the second is told why', async () => {
  await withDaemon(async (deliver, inputId, broker) => {
    const [first, second] = await Promise.all([deliver(inputId, { claim: true }), deliver(inputId, { claim: true })]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const refused = await (first.status === 409 ? first : second).json() as { code: string; error: string; input: { state: string } };
    expect(refused.code).toBe('INPUT_NOT_CLAIMABLE');
    expect(refused.input.state).toBe('delivered');
    expect(broker.getInputs('s1', 10).filter((entry) => (entry as { state: string }).state === 'delivered')).toHaveLength(1);
  });
});

test('a claim that sat unanswered past the lease can be taken over, and the takeover restarts the lease', async () => {
  await withDaemon(async (deliver, inputId) => {
    expect((await deliver(inputId, { claim: true })).status).toBe(200);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3 * 60_000;
      expect((await deliver(inputId, { claim: true })).status).toBe(200);
      expect((await deliver(inputId, { claim: true })).status).toBe(409);
    } finally { Date.now = realNow; }
  });
});

test('an input that already has an agent is never claimable, however long ago', async () => {
  await withDaemon(async (deliver, inputId) => {
    expect((await deliver(inputId, { claim: true })).status).toBe(200);
    expect((await deliver(inputId, { agentId: 'agent-1' })).status).toBe(200);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60 * 60_000;
      expect((await deliver(inputId, { claim: true })).status).toBe(409);
    } finally { Date.now = realNow; }
  });
});

interface FakeInput { id: string; intent: 'submit'; body: string; state: 'queued' | 'delivered'; updatedAt: number; activeAgentId?: string }

/** A daemon that grants each input to one claimant, as the real one does. */
function claimingDaemon(inputs: FakeInput[]) {
  const claimedBy = new Map<string, string>();
  const clientFor = (who: string, onClaim?: () => void): SessionInputsWireClient => ({
    listInputs: async (_sessionId, options) => ({ inputs: inputs.filter((input) => input.state === options.state) }) as never,
    claimInput: async (_sessionId, inputId) => {
      onClaim?.();
      if (claimedBy.has(inputId)) throw Object.assign(new Error('Cannot claim input'), { transport: { status: 409 } });
      claimedBy.set(inputId, who);
      const input = inputs.find((entry) => entry.id === inputId)!;
      input.state = 'delivered';
    },
    deliverInput: async (_sessionId, inputId, options) => {
      if (options?.agentId) inputs.find((entry) => entry.id === inputId)!.activeAgentId = options.agentId;
    },
  });
  return { clientFor, claimedBy };
}

test('two dispatchers hosting one session start one agent between them', async () => {
  const daemon = claimingDaemon([{ id: 'i1', intent: 'submit', body: 'hello', state: 'queued', updatedAt: 0 }]);
  const started: string[] = [];
  const dispatchers = ['a', 'b'].map((who) => {
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], log: quiet, intervalMs: 3_600_000 });
    dispatch.setContinuationRunner(() => { started.push(who); return { disposition: 'started', agentId: `agent-${who}` } as never; });
    dispatch.activate(daemon.clientFor(who));
    return dispatch;
  });
  await Promise.all(dispatchers.map((dispatch) => dispatch.pollNow()));
  await Promise.all(dispatchers.map((dispatch) => dispatch.pollNow()));
  dispatchers.forEach((dispatch) => dispatch.stop());
  expect(started).toHaveLength(1);
});

test('an input the runner held after it was claimed is retried by the claimant, not left stranded', async () => {
  const daemon = claimingDaemon([{ id: 'i1', intent: 'submit', body: 'hello', state: 'queued', updatedAt: 0 }]);
  let attempts = 0;
  const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], log: quiet, intervalMs: 3_600_000, now: () => 5_000 });
  dispatch.setContinuationRunner(() => {
    attempts += 1;
    return (attempts === 1 ? { disposition: 'held' } : { disposition: 'started', agentId: 'agent-1' }) as never;
  });
  dispatch.activate(daemon.clientFor('a'));
  await dispatch.pollNow();
  await dispatch.pollNow();
  dispatch.stop();
  expect(attempts).toBe(2);
});

test('a claim the daemon could not be asked about leaves the input for the next tick', async () => {
  const inputs: FakeInput[] = [{ id: 'i1', intent: 'submit', body: 'hello', state: 'queued', updatedAt: 0 }];
  let reachable = false;
  const daemon = claimingDaemon(inputs);
  const client = daemon.clientFor('a', () => { if (!reachable) throw new Error('connection refused'); });
  const ran: string[] = [];
  const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], log: quiet, intervalMs: 3_600_000 });
  dispatch.setContinuationRunner(() => { ran.push('started'); return { disposition: 'started', agentId: 'agent-1' } as never; });
  dispatch.activate(client);
  await dispatch.pollNow();
  expect(ran).toEqual([]);
  reachable = true;
  await dispatch.pollNow();
  dispatch.stop();
  expect(ran).toEqual(['started']);
});

/**
 * A pending approval survives a daemon restart and is never left hanging.
 *
 * The broker once kept every expiry timer only in memory, so a restart left a
 * timed approval pending forever with nothing that would resolve it; for a
 * payment that is money in limbo, and silence on an approval means denied.
 *
 * Real broker over a real store file; a restart is a second broker over the
 * same file after the first one's timers were dropped (the process died). The
 * clock is bun's fake clock, moved only by the test.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../platform/src/platform/control-plane/approval-broker.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-approval-rearm-'));
  storePath = join(dir, 'approvals.json');
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** Each ask has its own args, so none coalesces onto another. */
function request(callId: string): PermissionPromptRequest {
  return {
    callId,
    tool: 'payments.purchase',
    args: { merchant: `${callId}.example` },
    category: 'execute',
    analysis: { classification: 'payment', riskLevel: 'high', summary: 'Buy a burr coffee grinder for USD 120.00', reasons: [] },
  };
}

/** Raise an ask on `broker` and return once it is in the store file. */
async function raise(broker: ApprovalBroker, callId: string, extra: { timeoutMs?: number; metadata?: Record<string, unknown> } = {}): Promise<SharedApprovalRecord> {
  const raised = await broker.raiseApproval({ request: request(callId), ...extra });
  // The waiter dies with the process in the real case.
  void raised.decision.catch(() => undefined);
  return raised.approval;
}

/** The process dies: its timers go with it. A new broker over the same file is the restart. */
async function restart(): Promise<ApprovalBroker> {
  jest.clearAllTimers();
  const next = new ApprovalBroker({ storePath });
  await next.start();
  return next;
}

const record = (broker: ApprovalBroker, callId: string) => broker.listApprovals().find((entry) => entry.callId === callId);

/** Let the event loop turn until `done` holds; bounded in turns, never in milliseconds. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 20_000; turn += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  if (!done()) throw new Error(`Gave up waiting for: ${what}`);
}

test('a deadline that passed while the daemon was down is denied at start-up; an approval already given stays given', async () => {
  const first = new ApprovalBroker({ storePath });
  await first.start();
  await raise(first, 'lapsed', { timeoutMs: 60_000 });
  const given = await raise(first, 'given', { timeoutMs: 60_000 });
  await first.resolveApproval(given.id, { approved: true, actor: 'owner', actorSurface: 'tui' });

  jest.advanceTimersByTime(61_000);
  const second = await restart();
  await until(() => record(second, 'lapsed')?.status === 'expired', 'the lapsed ask to be settled');
  expect(record(second, 'lapsed')?.decision?.approved).toBe(false);
  expect(record(second, 'given')?.status).toBe('approved');
});

test('a deadline still ahead is kept and fires after the restart', async () => {
  const first = new ApprovalBroker({ storePath });
  await first.start();
  await raise(first, 'ahead', { timeoutMs: 60_000 });

  jest.advanceTimersByTime(30_000);
  const second = await restart();
  // Not expired on sight: it still has time to be answered.
  expect(record(second, 'ahead')?.status).toBe('pending');

  jest.advanceTimersByTime(30_001);
  await until(() => record(second, 'ahead')?.status === 'expired', 'the re-armed deadline to fire');
  expect(record(second, 'ahead')?.decision?.approved).toBe(false);
  expect(record(second, 'ahead')?.audit.some((entry) => entry.action === 'expired' && entry.note?.includes('re-armed'))).toBe(true);
});

test('with no deadline, an ask whose waiter died is cancelled and the next one prompts afresh; one raised over the wire stays open', async () => {
  const first = new ApprovalBroker({ storePath });
  await first.start();
  await raise(first, 'in-process');
  await raise(first, 'over-the-wire', { metadata: { raisedVia: 'approvals.raise' } });

  const second = await restart();
  await until(() => record(second, 'in-process')?.status === 'cancelled', 'the orphaned ask to be cancelled');
  expect(record(second, 'in-process')?.decision?.approved).toBe(false);
  // The sweep has run (it cancelled the other one); the remote caller's ask is still open for it.
  expect(record(second, 'over-the-wire')?.status).toBe('pending');

  let prompted = 0;
  const again = second.requestApproval({
    request: { ...request('in-process-again'), args: request('in-process').args },
    localPrompt: async () => { prompted += 1; return { approved: true }; },
  });
  expect((await again).approved).toBe(true);
  expect(prompted).toBe(1);
});

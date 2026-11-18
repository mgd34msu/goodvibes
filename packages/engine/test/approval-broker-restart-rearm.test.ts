// Proves: An approval outlives its deadline across a daemon restart, so a purchase or action waiting on it can be approved long after the window the owner was given; or an approval already given is lost by the restart.
// Red when: The start-up pass stops expiring an approval whose deadline passed while the daemon was down, a restart loses an approval already given, or a deadline still ahead is not re-armed or expires on sight.
/**
 * A pending approval survives a daemon restart and is never left hanging.
 *
 * The broker once kept every expiry timer only in memory, so a restart left a
 * timed approval pending forever with nothing that would resolve it; for a
 * payment that is money in limbo, and silence on an approval means denied.
 *
 * Real broker over a real store file; a restart is a second broker over the
 * same file. The date is bun's setSystemTime: frozen, moved only by the test.
 * Timers stay real. Every window is ten minutes, so a timer the first broker
 * armed cannot fire while the file runs, as if its process had died; the one
 * deadline the restarted broker must fire is 1 ms ahead.
 *
 * Not bun's fake timers: with them on, a file read could stop completing on a
 * machine booted shortly before (a fresh CI runner), and the case stalled on
 * the store read instead of proving anything.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../platform/src/platform/control-plane/approval-broker.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';

/** Far longer than the file may run, so no timer of the first broker fires during it. */
const WINDOW_MS = 10 * 60_000;
const START = Date.parse('2026-11-01T12:00:00Z');

let dir: string;
let storePath: string;
let clock = START;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-approval-rearm-'));
  storePath = join(dir, 'approvals.json');
  clock = START;
  setSystemTime(new Date(clock));
});
afterEach(() => {
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

/** Time passes while the daemon is down. */
function moveClock(ms: number): void {
  clock += ms;
  setSystemTime(new Date(clock));
}

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

/** A new broker over the same file is the restart. */
async function restart(): Promise<ApprovalBroker> {
  const next = new ApprovalBroker({ storePath });
  await next.start();
  return next;
}

const record = (broker: ApprovalBroker, callId: string) => broker.listApprovals().find((entry) => entry.callId === callId);

/** Let the event loop turn until `done` holds; bounded in turns, never in milliseconds. A miss says what it saw. */
async function until(done: () => boolean, what: string, seen: () => unknown): Promise<void> {
  for (let turn = 0; turn < 20_000; turn += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  if (!done()) throw new Error(`Gave up waiting for ${what}; the record is ${JSON.stringify(seen()) ?? 'missing'}`);
}

test('a deadline that passed while the daemon was down is denied at start-up; an approval already given stays given', async () => {
  const first = new ApprovalBroker({ storePath });
  await first.start();
  await raise(first, 'lapsed', { timeoutMs: WINDOW_MS });
  const given = await raise(first, 'given', { timeoutMs: WINDOW_MS });
  await first.resolveApproval(given.id, { approved: true, actor: 'owner', actorSurface: 'tui' });

  moveClock(WINDOW_MS + 1_000);
  const second = await restart();
  await until(() => record(second, 'lapsed')?.status === 'expired', 'the lapsed ask to be settled', () => record(second, 'lapsed')?.status);
  expect(record(second, 'lapsed')?.decision?.approved).toBe(false);
  expect(record(second, 'given')?.status).toBe('approved');
});

test('a deadline still ahead is kept and fires after the restart', async () => {
  const first = new ApprovalBroker({ storePath });
  await first.start();
  await raise(first, 'ahead', { timeoutMs: WINDOW_MS });

  moveClock(WINDOW_MS - 1);
  const second = await restart();
  // Not expired on sight: it still has time to be answered.
  expect(record(second, 'ahead')?.status).toBe('pending');

  await until(() => record(second, 'ahead')?.status === 'expired', 'the re-armed deadline to fire', () => record(second, 'ahead')?.status);
  expect(record(second, 'ahead')?.decision?.approved).toBe(false);
});

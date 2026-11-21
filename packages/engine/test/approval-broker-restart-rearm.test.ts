// Proves: An approval outlives its deadline across a daemon restart, so a purchase or action waiting on it can be approved long after the window the owner was given; or an approval already given is lost by the restart.
// Red when: The start-up pass stops expiring an approval whose deadline passed while the daemon was down, a restart loses an approval already given, or a deadline still ahead is not re-armed or expires on sight.
// Proves: Two people answer one approval at once and the waiting command runs with the typed answer of one whose decision did not stand, or a decision given to a revision that has since changed is applied.
// Red when: The broker applies a second decision to a settled approval or one given to a stale revision, or hands the waiting command an answer other than the applied one.
// Proves: A change put to the owner is recorded as approved while it is not in effect, or a change that could not be applied ends the owner's ask as if decided.
// Red when: The owner's approve records the approval without running the change registered for it, or records it approved when the change failed instead of leaving the ask waiting.
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
import { buildExecPromptAnswerHandler } from '../platform/src/platform/runtime/permissions/exec-prompt-wiring.ts';
import { putToOwner } from '../platform/src/platform/control-plane/owner-act.ts';

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

/**
 * The first record `broker` holds that matches: at once if it already does, else when the broker
 * publishes the change, which it does once the record is durable.
 */
function held(broker: ApprovalBroker, matches: (entry: SharedApprovalRecord) => boolean): Promise<SharedApprovalRecord> {
  return new Promise((resolve) => {
    const now = broker.listApprovals().find(matches);
    if (now) { resolve(now); return; }
    const off = broker.subscribe((entry) => { if (matches(entry)) { off(); resolve(entry); } });
  });
}

const expired = (callId: string) => (entry: SharedApprovalRecord) => entry.callId === callId && entry.status === 'expired';

test('a deadline that passed while the daemon was down is denied at start-up; an approval already given stays given', async () => {
  const first = new ApprovalBroker({ storePath });
  await first.start();
  await raise(first, 'lapsed', { timeoutMs: WINDOW_MS });
  const given = await raise(first, 'given', { timeoutMs: WINDOW_MS });
  expect((await first.resolveApproval(given.id, { approved: true, actor: 'owner', actorSurface: 'tui', expectedRevision: given.revision })).applied).toBe(true);

  moveClock(WINDOW_MS + 1_000);
  const second = await restart();
  await held(second, expired('lapsed'));
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

  await held(second, expired('ahead'));
  expect(record(second, 'ahead')?.decision?.approved).toBe(false);
});

test('two approvers at once: one decision stands, the command gets only its typed answer, and a stale revision is refused', async () => {
  const broker = new ApprovalBroker({ storePath });
  await broker.start();
  // A command stopped on its terminal asks for a passphrase through the broker, as exec does.
  const answerPrompt = buildExecPromptAnswerHandler({ attended: () => true, requestApproval: (input) => broker.requestApproval(input) });
  const command = answerPrompt({ command: 'gpg --sign release.tar', prompt: 'Passphrase:', recentOutput: '' });
  const raised = await held(broker, () => true);
  expect(broker.listApprovals()).toHaveLength(1);

  // A stale revision: another surface claimed it after this approver was shown it.
  expect((await broker.claimApproval(raised.id, { actor: 'operator', actorSurface: 'web', expectedRevision: raised.revision })).applied).toBe(true);
  const stale = await broker.resolveApproval(raised.id, { approved: true, actor: 'owner', actorSurface: 'tui', expectedRevision: raised.revision, modifiedArgs: { answer: 'stale-typed' } });
  expect(stale.applied ? 'applied' : stale.refusal.code).toBe('APPROVAL_CHANGED');

  // Both approvers were shown the current revision and answer at once with different typed answers.
  const shown = broker.getApproval(raised.id)!.revision;
  const [tui, web] = await Promise.all([
    broker.resolveApproval(raised.id, { approved: true, actor: 'owner', actorSurface: 'tui', expectedRevision: shown, modifiedArgs: { answer: 'typed-in-tui' } }),
    broker.resolveApproval(raised.id, { approved: true, actor: 'owner', actorSurface: 'web', expectedRevision: shown, modifiedArgs: { answer: 'typed-in-web' } }),
  ]);
  // Each decision is checked and written in turn: exactly one stands, the other is refused.
  expect([tui.applied, web.applied]).toContain(false);
  expect([tui.applied, web.applied]).toContain(true);
  const stood = tui.applied ? 'typed-in-tui' : 'typed-in-web';
  const answered = await command;
  expect(answered).toEqual({ answered: true, text: stood });
  expect(broker.getApproval(raised.id)?.audit.filter((entry) => entry.action === 'approved').length).toBe(1);
});

test('a change put to the owner is in effect when his approve returns; one that cannot be applied leaves the ask waiting', async () => {
  const broker = new ApprovalBroker({ storePath });
  await broker.start();
  // An admin who is not the owner asked to switch the sandbox off: the change is put to the owner.
  const settings = { 'sandbox.enabled': true };
  let diskFull = true;
  const { approvalId } = await putToOwner(broker, {
    summary: 'Switch the sandbox off', reasons: ['sandbox.enabled: true -> false'],
    tool: 'config.set', args: { key: 'sandbox.enabled', value: false }, requestedBy: 'admin-2',
    apply: () => {
      if (diskFull) throw new Error('ENOSPC: no space left on device');
      settings['sandbox.enabled'] = false;
    },
  });
  const approve = () => broker.resolveApproval(approvalId, { approved: true, actor: 'owner', actorSurface: 'tui', expectedRevision: broker.getApproval(approvalId)!.revision });

  // The change fails: nothing was decided, and the ask still waits for him.
  const failed = await approve().then(() => 'recorded', (error: { code?: unknown }) => error.code);
  expect(failed).toBe('APPROVED_NOT_APPLIED');
  expect(broker.getApproval(approvalId)?.status).toBe('pending');
  expect(settings['sandbox.enabled']).toBe(true);

  // Approved again once it can be applied: the change is in effect by the time the approval says approved.
  diskFull = false;
  expect((await approve()).applied).toBe(true);
  expect(settings['sandbox.enabled']).toBe(false);
  expect((await restart()).getApproval(approvalId)?.status).toBe('approved');
});

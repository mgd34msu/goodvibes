import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import { createOwnerInbox, type OwnerInbox } from '../platform/src/platform/control-plane/owner-inbox.js';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';

const roots: string[] = [];
const inboxes: OwnerInbox[] = [];
afterEach(() => {
  for (const inbox of inboxes.splice(0)) inbox.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-inbox-fixture-'));
  roots.push(root);
  const questionsPath = join(root, 'owner-inbox.jsonl');
  const broker = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
  const open = () => {
    const inbox = createOwnerInbox({ approvals: broker, questionsPath });
    inboxes.push(inbox);
    return inbox;
  };
  return { broker, open };
}

function request(): PermissionPromptRequest {
  return { callId: 'call-1', tool: 'exec', args: { cmd: 'make release' }, category: 'execute', analysis: { classification: 'command', riskLevel: 'high', summary: 'Run make release', reasons: ['publishes a build'] } };
}

test('the first answer wins, a later one names who answered, and both survive a restart', async () => {
  const { open } = fixture();
  const inbox = open();
  const posted = inbox.postNow({ kind: 'question', title: 'Ship on Friday?', options: ['yes', 'no'], key: 'ship-friday', askedBy: 'release agent' });
  expect(posted.created).toBe(true);
  // A retried post under the same open key does not ask twice.
  expect(inbox.postNow({ kind: 'question', title: 'Ship on Friday?', options: ['yes', 'no'], key: 'ship-friday' })).toEqual({ created: false, item: posted.item });

  const first = await inbox.answer(posted.item.id, { option: 'YES', text: 'after the tests pass' }, { actor: 'owner', surface: 'tui' });
  expect(first.applied).toBe(true);
  const second = await inbox.answer(posted.item.id, { option: 'no' }, { actor: 'owner', surface: 'web' });
  expect(second.applied).toBe(false);
  if (second.applied) throw new Error('unreachable');
  expect(second.refusal.code).toBe('ALREADY_ANSWERED');
  expect(second.refusal.reason).toContain('owner from tui');

  inbox.dispose();
  inboxes.splice(inboxes.indexOf(inbox), 1);
  const reopened = open();
  const item = reopened.get(posted.item.id);
  expect(item?.status).toBe('answered');
  expect(item?.answer).toEqual({ option: 'yes', text: 'after the tests pass' });
  expect(item?.answeredBy).toEqual({ actor: 'owner', surface: 'tui' });
  expect(reopened.listNow()).toEqual([]);
  expect(reopened.listNow({ status: 'closed' }).map((entry) => entry.id)).toEqual([posted.item.id]);
});

test('an approval answered through the inbox reaches the waiting call once', async () => {
  const { broker, open } = fixture();
  const inbox = open();
  const raised = await broker.raiseApproval({ request: request(), sessionId: 'session-1' });
  const listed = inbox.listNow({ kinds: ['approval'] });
  expect(listed.map((item) => [item.id, item.status, item.options])).toEqual([[raised.approval.id, 'open', ['approve', 'deny']]]);

  const answered = await inbox.answer(raised.approval.id, { option: 'approve' }, { actor: 'owner', surface: 'web' });
  expect(answered.applied).toBe(true);
  expect((await raised.decision).approved).toBe(true);

  const late = await inbox.answer(raised.approval.id, { option: 'deny' }, { actor: 'owner', surface: 'tui' });
  expect(late.applied).toBe(false);
  if (late.applied) throw new Error('unreachable');
  expect(late.refusal.code).toBe('ALREADY_ANSWERED');
  expect(broker.getApproval(raised.approval.id)?.status).toBe('approved');
});

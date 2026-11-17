// Proves: The owner's answer is changed after the fact, lost on restart, never reaches the waiting call, or is inverted for an approval.
// Red when: A second answer overwrites the first or the answer is not on disk when `answer` returns, approve and deny map wrongly to the broker, or another process's answer never reaches the waiting call.
/**
 * The owner inbox: the first answer wins and survives a restart, an approval
 * answered there reaches the waiting call once, and an answer written by
 * another process (a terminal app on the same store) wakes a call waiting in
 * this one.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  return { root, questionsPath, broker, open };
}

const INBOX_MODULE = join(import.meta.dir, '..', 'platform', 'src', 'platform', 'control-plane', 'owner-inbox.ts');

/**
 * A second process on the same store answers the item, as a terminal app does,
 * and reports whether its answer applied. `postsFirst` items are posted just
 * before, so the answer is the last commit of a quick burst.
 */
async function answerInAnotherProcess(root: string, questionsPath: string, id: string, option: string, postsFirst = 0): Promise<boolean> {
  const script = join(root, 'answer.ts');
  writeFileSync(script, [
    `import { createOwnerInbox } from ${JSON.stringify(INBOX_MODULE)};`,
    'const [path, id, option, posts] = process.argv.slice(2);',
    'const inbox = createOwnerInbox({ questionsPath: path! });',
    "for (let n = 0; n < Number(posts); n += 1) inbox.postNow({ kind: 'question', title: `Also: item ${n}?`, options: ['yes', 'no'] });",
    "const outcome = await inbox.answer(id!, { option: option! }, { actor: 'owner', surface: 'tui' });",
    'inbox.dispose();',
    'console.log(JSON.stringify(outcome.applied));',
    '',
  ].join('\n'));
  const child = Bun.spawn(['bun', script, questionsPath, id, option, String(postsFirst)], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, err }).toEqual({ exit: 0, err: '' });
  return JSON.parse(out.trim()) as boolean;
}

function request(): PermissionPromptRequest {
  return { callId: 'call-1', tool: 'exec', args: { cmd: 'make release' }, category: 'execute', analysis: { classification: 'command', riskLevel: 'high', summary: 'Run make release', reasons: ['publishes a build'] } };
}

test('the first answer wins, a later one is refused, and the answer and who gave it survive a restart', async () => {
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

test('an answer written by another process wakes the call waiting in this one, also as the last write of a burst', async () => {
  const { root, questionsPath, open } = fixture();
  const inbox = open();
  const posted = inbox.postNow({ kind: 'question', title: 'Rotate the deploy key?', options: ['yes', 'no'], askedBy: 'ops agent' });
  const waiting = inbox.waitForAnswer(posted.item.id);

  expect(await answerInAnotherProcess(root, questionsPath, posted.item.id, 'yes', 6)).toBe(true);
  // The wait is on the waiting call itself; if it is never woken, the runner's file deadline fails the proof.
  const heard = await waiting;
  expect(heard.status).toBe('answered');
  expect(heard.answer?.option).toBe('yes');
  expect(heard.answeredBy).toEqual({ actor: 'owner', surface: 'tui' });
});

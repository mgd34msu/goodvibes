// Proves: The owner's answer is changed after the fact, lost on restart, never reaches the waiting call, or is inverted for an approval.
// Red when: A second answer overwrites the first or the answer is not on disk when `answer` returns, approve and deny map wrongly to the broker or a stale revision is applied, another process's answer never reaches the waiting call, or a reopen trims an answered item or a decided approval.
// Proves: An owner's answer to an agent is counted delivered before the model request carrying it was accepted, or vanishes when the process that took it dies.
// Red when: Taking an answer marks it delivered, a second taker gets it while the first lives, or a dead taker's answer is never handed to the next one.
/**
 * The owner inbox: the first answer wins and survives a restart, an approval
 * answered there reaches the waiting call once, an answer written by another
 * process (a terminal app on the same store) wakes a call waiting in this one,
 * the owner's answers outlast the trim of old history, and an answer an agent
 * took is delivered only on confirmation, or handed again when its taker died.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import { createOwnerInbox, listEveryOwnerItem, OWNER_ANSWER_AGENT_METADATA, type OwnerInbox } from '../platform/src/platform/control-plane/owner-inbox.js';
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

function request(n = 1): PermissionPromptRequest {
  return { callId: `call-${n}`, tool: 'exec', args: { cmd: n === 1 ? 'make release' : `make release-${n}` }, category: 'execute', analysis: { classification: 'command', riskLevel: 'high', summary: 'Run make release', reasons: ['publishes a build'] } };
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
  const shown = listed[0]!.revision!;

  // Another surface claims it after the owner was shown it: his answer to the revision he saw is refused, nothing is decided.
  expect((await broker.claimApproval(raised.approval.id, { actor: 'operator', actorSurface: 'web', expectedRevision: shown })).applied).toBe(true);
  const stale = await inbox.answer(raised.approval.id, { option: 'approve', expectedRevision: shown }, { actor: 'owner', surface: 'web' });
  expect(stale.applied).toBe(false);
  if (stale.applied) throw new Error('unreachable');
  expect(stale.refusal.code).toBe('APPROVAL_CHANGED');
  expect(broker.getApproval(raised.approval.id)?.status).toBe('claimed');

  const current = inbox.get(raised.approval.id)!.revision!;
  const answered = await inbox.answer(raised.approval.id, { option: 'approve', expectedRevision: current }, { actor: 'owner', surface: 'web' });
  expect(answered.applied).toBe(true);
  expect((await raised.decision).approved).toBe(true);

  const late = await inbox.answer(raised.approval.id, { option: 'deny', expectedRevision: current }, { actor: 'owner', surface: 'tui' });
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

test('answered items and decided approvals past five hundred survive a reopen; only undecided closed ones are trimmed', async () => {
  const { root, questionsPath, broker, open } = fixture();
  const inbox = open();
  const owner = { actor: 'owner', surface: 'tui' };
  // The owner's own answers first, so they are the oldest history when the trim runs.
  for (let n = 0; n < 505; n += 1) {
    const posted = inbox.postNow({ kind: 'question', title: `Answered ${n}?`, options: ['yes', 'no'] });
    expect((await inbox.answer(posted.item.id, { option: n % 2 === 0 ? 'yes' : 'no' }, owner)).applied).toBe(true);
    const raised = await broker.raiseApproval({ request: request(1000 + n) });
    expect((await inbox.answer(raised.approval.id, { option: n % 2 === 0 ? 'approve' : 'deny', expectedRevision: raised.approval.revision }, owner)).applied).toBe(true);
    await raised.decision;
  }
  for (let n = 0; n < 501; n += 1) {
    const posted = inbox.postNow({ kind: 'question', title: `Dropped ${n}?`, options: ['yes', 'no'] });
    expect(inbox.withdraw(posted.item.id, 'no longer needed').applied).toBe(true);
    const raised = await broker.raiseApproval({ request: request(5000 + n) });
    void raised.decision.catch(() => undefined);
    expect((await broker.cancelApproval(raised.approval.id, { actor: 'owner', expectedRevision: raised.approval.revision })).applied).toBe(true);
  }
  inbox.dispose();
  inboxes.splice(inboxes.indexOf(inbox), 1);

  // The restart: a new broker over the same log, a new inbox over the same store.
  const restarted = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
  await restarted.start();
  const reopened = createOwnerInbox({ approvals: restarted, questionsPath });
  inboxes.push(reopened);
  const closed = await listEveryOwnerItem(reopened, { status: 'closed' });
  const count = (kind: string, status: string) => closed.filter((item) => item.kind === kind && item.status === status).length;
  expect({
    answeredQuestions: count('question', 'answered'),
    withdrawnQuestions: count('question', 'withdrawn'),
    decidedApprovals: count('approval', 'answered'),
    cancelledApprovals: count('approval', 'withdrawn'),
  }).toEqual({ answeredQuestions: 505, withdrawnQuestions: 500, decidedApprovals: 505, cancelledApprovals: 500 });
  expect(closed.filter((item) => item.kind === 'question' && item.status === 'answered' && item.answer?.option === 'yes').length).toBe(253);
});

/**
 * A second process takes the answer, as an agent's turn does when it puts it on
 * a model request, prints whether it got it, and stays until it is killed: it
 * never confirms, as a process that died before the provider accepted.
 */
function takeInAnotherProcess(root: string, questionsPath: string, id: string) {
  const script = join(root, 'take.ts');
  writeFileSync(script, [
    `import { createOwnerInbox } from ${JSON.stringify(INBOX_MODULE)};`,
    'const [path, id] = process.argv.slice(2);',
    'const inbox = createOwnerInbox({ questionsPath: path! });',
    'console.log(JSON.stringify(inbox.take(id!)));',
    'for await (const _ of Bun.stdin.stream()) { /* held open until killed */ }',
    '',
  ].join('\n'));
  const child = Bun.spawn(['bun', script, questionsPath, id], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const firstLine = (async () => {
    const reader = child.stdout.getReader();
    let text = '';
    while (!text.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    return text.trim();
  })();
  return { child, firstLine };
}

test('an answer an agent took is delivered only when its request was accepted; a taker killed before that leaves it to the next', async () => {
  const { root, questionsPath, open } = fixture();
  const inbox = open();
  const posted = inbox.postNow({ kind: 'question', title: 'Which region?', options: ['eu', 'us'], metadata: { [OWNER_ANSWER_AGENT_METADATA]: 'agent-7' } });
  expect((await inbox.answer(posted.item.id, { option: 'eu' }, { actor: 'owner', surface: 'tui' })).applied).toBe(true);
  const pending = () => inbox.pendingFor({ agent: 'agent-7' }).map((item) => item.id);

  const taker = takeInAnotherProcess(root, questionsPath, posted.item.id);
  try {
    expect(await taker.firstLine).toBe('true');
    // Taken, not accepted: still owed to the agent, not delivered, and no second taker gets it while the first lives.
    expect(inbox.get(posted.item.id)?.delivery?.state).not.toBe('delivered');
    expect(pending()).toEqual([posted.item.id]);
    expect(inbox.take(posted.item.id)).toBe(false);
  } finally {
    taker.child.kill('SIGKILL');
    await taker.child.exited;
  }

  // The taker died before its request was accepted: the answer is handed to the next taker, and delivered on its confirmation.
  expect(inbox.take(posted.item.id)).toBe(true);
  expect(pending()).toEqual([posted.item.id]);
  inbox.confirmDelivered([posted.item.id]);
  expect(inbox.get(posted.item.id)?.delivery?.state).toBe('delivered');
  expect(pending()).toEqual([]);
});

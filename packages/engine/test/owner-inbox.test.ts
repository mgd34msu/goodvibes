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
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import { createOwnerInbox, listEveryOwnerItem, OWNER_ANSWER_AGENT_METADATA, type OwnerInbox } from '../platform/src/platform/control-plane/owner-inbox.js';
import { sharedQuestionStore } from '../platform/src/platform/control-plane/question-store.js';
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
 * Another process on the same store, started when this file loads so its
 * start-up (most of a second, loading the inbox's modules) overlaps the cases
 * before the one that uses it. It waits for one line of tab-separated
 * arguments on stdin, then runs `body` with them as `args`.
 */
function otherProcess(name: string, body: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), `owner-inbox-${name}-`));
  const script = join(dir, `${name}.ts`);
  writeFileSync(script, [
    `import { createOwnerInbox } from ${JSON.stringify(INBOX_MODULE)};`,
    'const stdin = Bun.stdin.stream().getReader();',
    "let line = '';",
    "while (!line.includes('\\n')) { const { done, value } = await stdin.read(); if (done) process.exit(3); line += new TextDecoder().decode(value); }",
    "const args = line.trim().split('\\t');",
    ...body,
    '',
  ].join('\n'));
  const child = Bun.spawn(['bun', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
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
  return {
    child, dir, firstLine,
    send(...args: string[]) { child.stdin.write(`${args.join('\t')}\n`); void child.stdin.flush(); },
  };
}

/**
 * A terminal app on the same store: answers the item and reports whether its
 * answer applied. `posts` items are posted just before, so the answer is the
 * last commit of a quick burst.
 */
const answerer = otherProcess('answer', [
  'const [path, id, option, posts] = args;',
  'const inbox = createOwnerInbox({ questionsPath: path! });',
  "for (let n = 0; n < Number(posts); n += 1) inbox.postNow({ kind: 'question', title: `Also: item ${n}?`, options: ['yes', 'no'] });",
  "const outcome = await inbox.answer(id!, { option: option! }, { actor: 'owner', surface: 'tui' });",
  'inbox.dispose();',
  'console.log(JSON.stringify(outcome.applied));',
  'process.exit(0);',
]);

/**
 * An agent's process takes the answer, as its turn does when it puts the
 * answer on a model request, prints whether it got it, and stays until it is
 * killed: it never confirms, as a process that died before the provider
 * accepted the request.
 */
const taker = otherProcess('take', [
  'const [path, id] = args;',
  'console.log(JSON.stringify(createOwnerInbox({ questionsPath: path! }).take(id!)));',
  'for (;;) { const { done } = await stdin.read(); if (done) break; }',
]);

afterAll(async () => {
  for (const other of [answerer, taker]) {
    other.child.kill('SIGKILL');
    await other.child.exited;
    rmSync(other.dir, { recursive: true, force: true });
  }
});

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
  const { questionsPath, open } = fixture();
  const inbox = open();
  const posted = inbox.postNow({ kind: 'question', title: 'Rotate the deploy key?', options: ['yes', 'no'], askedBy: 'ops agent' });
  const waiting = inbox.waitForAnswer(posted.item.id);

  answerer.send(questionsPath, posted.item.id, 'yes', '6');
  const [answered, exit, err] = await Promise.all([answerer.firstLine, answerer.child.exited, new Response(answerer.child.stderr).text()]);
  expect({ exit, err }).toEqual({ exit: 0, err: '' });
  expect(JSON.parse(answered)).toBe(true);
  // The wait is on the waiting call itself; if it is never woken, the runner's file deadline fails the proof.
  const heard = await waiting;
  expect(heard.status).toBe('answered');
  expect(heard.answer?.option).toBe('yes');
  expect(heard.answeredBy).toEqual({ actor: 'owner', surface: 'tui' });
});

test('answered items and decided approvals survive a reopen whose trim drops undecided history past five hundred', async () => {
  const { root, questionsPath, broker, open } = fixture();
  const inbox = open();
  const owner = { actor: 'owner', surface: 'tui' };
  // The owner's own answers first, so they are the oldest history when the trim runs.
  for (let n = 0; n < 5; n += 1) {
    const posted = inbox.postNow({ kind: 'question', title: `Answered ${n}?`, options: ['yes', 'no'] });
    expect((await inbox.answer(posted.item.id, { option: n % 2 === 0 ? 'yes' : 'no' }, owner)).applied).toBe(true);
    const raised = await broker.raiseApproval({ request: request(1000 + n) });
    expect((await inbox.answer(raised.approval.id, { option: n % 2 === 0 ? 'approve' : 'deny', expectedRevision: raised.approval.revision }, owner)).applied).toBe(true);
    await raised.decision;
  }
  // One more undecided closed item of each kind than the trim keeps (MAX_CLOSED_ENTRIES and
  // MAX_APPROVAL_RECORDS, both 500), written through the stores themselves: the question store
  // the inbox is built on, and the broker.
  const questions = sharedQuestionStore(questionsPath);
  for (let n = 0; n < 501; n += 1) {
    const { entry } = questions.post({ kind: 'question', title: `Dropped ${n}?`, detail: '', options: ['yes', 'no'] }, Date.now(), () => true);
    expect(questions.withdraw(entry.item.id, 'no longer needed', Date.now())?.applied).toBe(true);
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
  }).toEqual({ answeredQuestions: 5, withdrawnQuestions: 500, decidedApprovals: 5, cancelledApprovals: 500 });
  expect(closed.filter((item) => item.kind === 'question' && item.status === 'answered' && item.answer?.option === 'yes').length).toBe(3);
});

test('an answer an agent took is delivered only when its request was accepted; a taker killed before that leaves it to the next', async () => {
  const { questionsPath, open } = fixture();
  const inbox = open();
  const posted = inbox.postNow({ kind: 'question', title: 'Which region?', options: ['eu', 'us'], metadata: { [OWNER_ANSWER_AGENT_METADATA]: 'agent-7' } });
  expect((await inbox.answer(posted.item.id, { option: 'eu' }, { actor: 'owner', surface: 'tui' })).applied).toBe(true);
  const pending = () => inbox.pendingFor({ agent: 'agent-7' }).map((item) => item.id);

  taker.send(questionsPath, posted.item.id);
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

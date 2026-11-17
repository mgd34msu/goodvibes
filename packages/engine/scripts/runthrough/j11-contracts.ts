/**
 * Journey 11: a contract with two units on the daemon.
 *
 * The ask is planned into two work units (each writes one file) and the
 * integration unit that joins them (an index naming both). The first agent of the second unit fails
 * with an error a retry cannot clear (the scripted provider refuses it with
 * HTTP 400), so the unit waits on the owner with one question, retry or
 * cancel, which is also an item in the owner inbox; the owner answers retry
 * there (inbox.answer), a second answer through contracts.reply is refused,
 * the daemon is restarted while the contract is in progress, and the contract
 * finishes after the restart with both files. With no decision model the
 * finished result is put to the owner (accept or cancel), answered in the inbox
 * too.
 *
 * It runs twice: under Hybrid with the scripted decision model on loopback
 * (fake-decision.ts), and with no decision model at all.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journey, api, approvePending, invoke, operatorToken, short, stage, waitFor, type Daemon, type Stage } from './lib.ts';
import { textOf, type ChatMessage, type Script } from './fake-model.ts';
import { answerAsAModelWould, startFakeDecision, type FakeDecision } from './fake-decision.ts';

const journey = new Journey('j11-contracts');

const ASK = 'RTCP write contract-a.txt and contract-b.txt';
const plan = {
  goal: 'Write contract-a.txt and contract-b.txt in the workspace.',
  criteria: [
    { id: 'c1', text: 'contract-a.txt exists in the workspace and contains A', quote: 'write contract-a.txt' },
    { id: 'c2', text: 'contract-b.txt exists in the workspace and contains B', quote: 'contract-b.txt' },
  ],
  groups: [
    {
      id: 'g1', kind: 'work', title: 'Write the files', goal: 'Both files written', dependsOn: [],
      criteria: [{ id: 'g1.c1', text: 'both files exist with their text', serves: ['c1', 'c2'] }],
      units: [
        { id: 'u1', title: 'Write contract-a.txt', goal: 'contract-a.txt written', role: 'implement', brief: 'RTCPUNITA write contract-a.txt with the text A',
          dependsOn: [], files: ['contract-a.txt'], attempts: 1,
          criteria: [{ id: 'u1.c1', text: 'contract-a.txt exists and contains A', serves: ['c1'], contribution: { kind: 'outcome', reason: 'It is the file asked for', verification: 'cat contract-a.txt prints A' } }] },
        { id: 'u2', title: 'Write contract-b.txt', goal: 'contract-b.txt written', role: 'implement', brief: 'RTCPUNITB write contract-b.txt with the text B',
          dependsOn: [], files: ['contract-b.txt'], attempts: 1,
          criteria: [{ id: 'u2.c1', text: 'contract-b.txt exists and contains B', serves: ['c2'], contribution: { kind: 'outcome', reason: 'It is the file asked for', verification: 'cat contract-b.txt prints B' } }] },
      ],
    },
    {
      id: 'g2', kind: 'integration', title: 'Join the files', goal: 'Both files are there together', dependsOn: ['g1'],
      criteria: [{ id: 'g2.c1', text: 'both files exist together', serves: ['c1', 'c2'] }],
      units: [
        { id: 'u3', title: 'Index both files', goal: 'contract-index.txt names both files', role: 'integration',
          brief: 'RTCPUNITI write contract-index.txt naming contract-a.txt and contract-b.txt, one per line',
          dependsOn: [], files: ['contract-index.txt'], attempts: 1,
          criteria: [{ id: 'u3.c1', text: 'contract-index.txt lists contract-a.txt and contract-b.txt', serves: ['c1', 'c2'],
            contribution: { kind: 'support', reason: 'It joins the two files into one deliverable', verification: 'cat contract-index.txt prints both names' } }] },
      ],
    },
  ],
};

const lastCall = (messages: readonly ChatMessage[]) => [...messages].reverse().find((message) => message.role === 'assistant' && message.tool_calls?.length)?.tool_calls?.[0];

/** A unit agent: one tool call, then its answer with the completion report. */
function unitScript(call: { name: string; args: Record<string, unknown> }, report: Record<string, unknown>, failFirst = false): Script {
  let started = 0;
  return (_step, messages) => {
    const results = messages.filter((message) => message.role === 'tool').map((message) => textOf(message.content));
    const last = results.at(-1) ?? '';
    if (/listed in one line/.test(last)) {
      const previous = lastCall(messages)!;
      return { calls: [{ name: previous.function.name, args: JSON.parse(previous.function.arguments) as Record<string, unknown> }] };
    }
    if (results.length === 0) {
      started += 1;
      if (failFirst && started === 1) return { errorStatus: 400 };
      return { calls: [call] };
    }
    return { text: `Done.\n\n\`\`\`json\n${JSON.stringify({ version: 1, ...report })}\n\`\`\`` };
  };
}

function script(s: Stage): void {
  s.model.scriptWrapped('RTCP', [{ text: `\`\`\`json\n${JSON.stringify(plan, null, 1)}\n\`\`\`` }]);
  s.model.scriptWrapped('RTCPUNITA', unitScript({ name: 'write', args: { files: [{ path: 'contract-a.txt', content: 'A\n' }] } },
    { archetype: 'engineer', summary: 'Wrote contract-a.txt with the text A.', gatheredContext: ['empty workspace'], plannedActions: ['write contract-a.txt'],
      appliedChanges: ['created contract-a.txt containing A'], filesCreated: ['contract-a.txt'], filesModified: [], filesDeleted: [], decisions: [], issues: [], uncertainties: [] }));
  s.model.scriptWrapped('RTCPUNITB', unitScript({ name: 'write', args: { files: [{ path: 'contract-b.txt', content: 'B\n' }] } },
    { archetype: 'engineer', summary: 'Wrote contract-b.txt with the text B.', gatheredContext: ['empty workspace'], plannedActions: ['write contract-b.txt'],
      appliedChanges: ['created contract-b.txt containing B'], filesCreated: ['contract-b.txt'], filesModified: [], filesDeleted: [], decisions: [], issues: [], uncertainties: [] }, true));
  s.model.scriptWrapped('RTCPUNITI', unitScript({ name: 'write', args: { files: [{ path: 'contract-index.txt', content: 'contract-a.txt\ncontract-b.txt\n' }] } },
    { archetype: 'engineer', summary: 'Wrote contract-index.txt naming both files.', gatheredContext: ['contract-a.txt and contract-b.txt exist'],
      plannedActions: ['write contract-index.txt'], appliedChanges: ['created contract-index.txt listing both files'], filesCreated: ['contract-index.txt'],
      filesModified: [], filesDeleted: [], decisions: [], issues: [], uncertainties: [],
      result: 'contract-a.txt (A) and contract-b.txt (B) are written; contract-index.txt names both.',
      finalAnswer: 'contract-a.txt (A) and contract-b.txt (B) are written in the workspace, and contract-index.txt names both.' }));
}

type InboxItem = { id: string; kind?: string; status: string; key?: string; title?: string; options?: string[]; answeredBy?: unknown };

/** The owner-inbox item a contract question is posted as (key contract-question:<escalationId>). */
async function inboxItemFor(daemon: Daemon, token: string, escalationId: string, status: 'open' | 'all' = 'open'): Promise<InboxItem | undefined> {
  const listed = await invoke(daemon, token, 'inbox.list', { status, limit: 200 });
  return ((listed.body as { items?: InboxItem[] }).items ?? []).find((item) => item.key === `contract-question:${escalationId}`);
}

type Contract = { id?: string; status?: string; units?: Array<{ id: string; status: string }>; escalations?: Array<{ id: string; question?: string; failurePause?: boolean; resolvedAt?: number | null; answer?: unknown }>; decisions?: Array<{ action: string; reason: string }> };

async function run(label: string, judgment: { endpoint: string; policy: string } | 'off', decision?: FakeDecision): Promise<void> {
  const s = await stage(`j11/${label}`, { judgment });
  try {
    if (decision) { s.home.allow(decision.port); await s.restartDaemon(); }
    script(s);
    await s.registerWorkspace();
    let token = operatorToken(s.home);
    const started = await api(s.daemon, token, 'POST', '/api/contracts', { ask: ASK, workspaceRoot: s.home.workspace, idempotencyKey: `rt-j11-${label}` });
    const contractId = (started.body as { contract?: Contract }).contract?.id ?? '';
    const read = async (): Promise<Contract> => (await api(s.daemon, token, 'GET', `/api/contracts/${encodeURIComponent(contractId)}`)).body as Contract;
    journey.check(`${label}: a contract starts on the daemon`, `POST /api/contracts { ask: "${ASK}" }`, `${started.status} ${short(started.text, 300)}`,
      started.status < 300 && contractId.length > 0);
    if (!contractId) return;

    // The second unit's first agent fails: the unit waits on the owner, retry or cancel.
    const paused = await waitFor(async () => {
      await approvePending(s.daemon, token);
      const contract = await read();
      const open = (contract.escalations ?? []).find((entry) => entry.failurePause === true && entry.resolvedAt === undefined);
      return open ? { contract, open } : (contract.status === 'failed' || contract.status === 'completed' ? { contract, open: undefined } : undefined);
    }, 90_000, 500);
    const unitStates = (paused?.contract.units ?? []).map((unit) => `${unit.id}:${unit.status}`).join(' ');
    const pausedItem = paused?.open ? await waitFor(() => inboxItemFor(s.daemon, token, paused.open!.id), 10_000) : undefined;
    journey.check(`${label}: a failed unit asks the owner to retry or cancel, in the owner inbox too`, 'the second unit\'s agent gets HTTP 400 from the provider; GET /api/contracts/<id>; inbox.list',
      `contract ${paused?.contract.status}; units ${unitStates}; question ${short(paused?.open?.question ?? 'none', 400)}; inbox item ${short(pausedItem ?? 'none', 400)}`,
      paused?.open !== undefined && /retry/.test(paused.open.question ?? '') && /cancel/.test(paused.open.question ?? '') && existsSync(join(s.home.workspace, 'contract-a.txt'))
        && pausedItem?.kind === 'question' && JSON.stringify(pausedItem.options) === JSON.stringify(['retry', 'cancel']));
    if (!paused?.open || !pausedItem) return;

    // The owner answers retry in the inbox; a second answer through contracts.reply finds the question answered.
    const answered = await invoke(s.daemon, token, 'inbox.answer', { itemId: pausedItem.id, option: 'retry' });
    const taken = await waitFor(async () => {
      const contract = await read();
      return (contract.escalations ?? []).find((entry) => entry.id === paused.open!.id && entry.resolvedAt !== undefined && entry.resolvedAt !== null) ? contract : undefined;
    }, 20_000);
    const second = await api(s.daemon, token, 'POST', `/api/contracts/${encodeURIComponent(contractId)}/reply`, { escalationId: paused.open.id, text: 'retry' });
    const before = await read();
    await s.restartDaemon();
    token = operatorToken(s.home);
    const after = await read();
    journey.check(`${label}: the owner answers retry in the inbox, a second answer is refused, and the contract's progress survives a daemon restart`,
      'inbox.answer { option: retry }; contracts.reply { escalationId, text: retry } again; restart the daemon; GET /api/contracts/<id>',
      `answer ${answered.status} ${short(answered.text, 200)}; taken ${taken !== undefined}; second reply ${second.status} ${short(second.text, 160)}; before ${before.status} ${(before.units ?? []).map((unit) => `${unit.id}:${unit.status}`).join(' ')}; after ${after.status} ${(after.units ?? []).map((unit) => `${unit.id}:${unit.status}`).join(' ')}`,
      answered.status < 300 && taken !== undefined && second.status === 409 && after.status !== undefined && after.status !== 'failed' && after.status !== 'cancelled'
        && (after.units ?? []).find((unit) => unit.id === 'u1')?.status === (before.units ?? []).find((unit) => unit.id === 'u1')?.status);

    const ended = (contract: Contract): boolean => contract.status === 'passed' || contract.status === 'failed' || contract.status === 'cancelled';
    // The finished work is the owner's to accept when no decision model reads it: he is asked once, and approves.
    const asked: string[] = [];
    const finished = await waitFor(async () => {
      await approvePending(s.daemon, token);
      const contract = await read();
      const open = (contract.escalations ?? []).find((entry) => entry.resolvedAt === undefined || entry.resolvedAt === null);
      if (!ended(contract) && contract.status === 'awaiting-owner' && open && !asked.includes(open.id)) {
        // The question names its own answer: "accept" to publish an unchecked result, else "approve"; it is answered in the owner inbox.
        const item = await inboxItemFor(s.daemon, token, open.id);
        if (!item) return undefined;
        asked.push(open.id);
        const accept = /Reply "accept"/.test(open.question ?? '');
        const approved = await invoke(s.daemon, token, 'inbox.answer', { itemId: item.id, ...(accept ? { option: 'accept' } : { text: 'approve' }) });
        asked.push(`${approved.status} options ${JSON.stringify(item.options)} ${short(open.question ?? '', 160)}`);
      }
      return ended(contract) ? contract : undefined;
    }, 150_000, 500);
    const final = finished ?? await read();
    if (label === 'nomodel') {
      journey.check(`${label}: with no decision model the owner is asked to accept the finished work, in the owner inbox`, 'the open question at the end; inbox.answer { option: accept }',
        short(asked, 400), asked.length === 2 && asked[1]!.startsWith('200 options ["accept","cancel"]'));
    } else {
      journey.check(`${label}: with a decision model the finished work is accepted without asking the owner`, 'open questions at the end', short(asked.length ? asked : 'none asked', 300), asked.length === 0);
    }
    writeFileSync(join(s.base, `j11-${label}-contract.json`), JSON.stringify(final, null, 2));
    // What the host told each unit's agent (its checks' findings), for reading a unit that did not pass.
    writeFileSync(join(s.base, `j11-${label}-unit-messages.json`), JSON.stringify(s.model.requests
      .filter((entry) => entry.marker?.startsWith('RTCPUNIT') || /Contract check \d+ on/.test(textOf(entry.messages.at(-1)?.content ?? '')))
      .map((entry) => ({ marker: entry.marker, step: entry.step, last: textOf(entry.messages.at(-1)?.content ?? '').slice(0, 4000) })), null, 2));
    const a = existsSync(join(s.home.workspace, 'contract-a.txt')) ? readFileSync(join(s.home.workspace, 'contract-a.txt'), 'utf8').trim() : null;
    const b = existsSync(join(s.home.workspace, 'contract-b.txt')) ? readFileSync(join(s.home.workspace, 'contract-b.txt'), 'utf8').trim() : null;
    const index = existsSync(join(s.home.workspace, 'contract-index.txt')) ? readFileSync(join(s.home.workspace, 'contract-index.txt'), 'utf8').trim().split('\n') : [];
    journey.check(`${label}: the contract finishes with both units' work`, 'wait for the contract to end; read the files',
      `contract ${final.status}; units ${(final.units ?? []).map((unit) => `${unit.id}:${unit.status}`).join(' ')}; files A=${a} B=${b} index=${JSON.stringify(index)}; last decisions ${short((final.decisions ?? []).slice(-4).map((entry) => `${entry.action}: ${entry.reason}`), 400)}`,
      final.status === 'passed' && a === 'A' && b === 'B' && index.includes('contract-a.txt') && index.includes('contract-b.txt'));
  } catch (error) {
    journey.check(`${label}: journey ran to the end`, 'j11', error instanceof Error ? error.stack ?? error.message : String(error), false);
  } finally {
    if (decision) writeFileSync(join(s.base, `j11-${label}-decisions.json`), JSON.stringify(decision.requests, null, 2));
    await s.close();
  }
}

const decision = startFakeDecision();
// The scripted decision model answers as a model would (fake-decision.ts): the provider's HTTP 400 is a bad
// request, not a sign-in failure that would take the provider out; a plan's criteria are checkable.
answerAsAModelWould(decision);
// RUNTHROUGH_J11_MODES (hybrid,nomodel) runs one of the two alone.
const modes = (process.env.RUNTHROUGH_J11_MODES ?? 'hybrid,nomodel').split(',');
if (modes.includes('hybrid')) await run('hybrid', { endpoint: decision.url, policy: 'Hybrid' }, decision);
decision.stop();
if (modes.includes('nomodel')) await run('nomodel', 'off');
journey.finish(process.env.RUNTHROUGH_DIR ?? '/tmp');

/**
 * Journey 16: an approval raised on one machine of a group is decided through
 * another, and every machine reads the same outcome.
 *
 * Three daemons from the checkout in one group (unicast peers on loopback):
 * A raises asks, B decides them, C is removed from the group. The home node
 * (A) is the only owner of its approvals; B reads summaries and relays.
 *  1. A wire client of A raises an ask and keeps its hold.
 *  2. B lists it as `<id>@A`, waiting for an approver, its home reachable.
 *  3. B approves it at the revision it read: applied on A, decided by `<person>@B`.
 *  4. A's raiser releases its hold; A and B read the same decision and receipt.
 *  5. A late approve through A is APPROVAL_SETTLED and changes nothing.
 *  6. With A paused, a decide through B answers NODE_UNREACHABLE (unknown) within
 *     about 5 s; once A runs again, B reads A's actual outcome.
 *  7. C is removed: A drops C's approvals from its list, and A refuses C's decide.
 *  8. A restarts between a decision and the raiser's release: receipt `waiting`,
 *     then `delivered` after the release.
 */
import type { OperatorMethodOutput } from '../../contracts/src/index.ts';
import { Journey, api, invoke, short, startGroup, waitFor } from './lib.ts';

/** The daemon's answers, as the operator contract states them. */
type ApprovalRow = OperatorMethodOutput<'approvals.list'>['approvals'][number];
type ApprovalAnswer = OperatorMethodOutput<'approvals.approve'>;
type Raised = OperatorMethodOutput<'approvals.raise'>;
type Inbox = OperatorMethodOutput<'inbox.list'>;
const journey = new Journey('j16-approvals-across-nodes');
const check = (step: string, ran: string, got: unknown, pass: boolean) => journey.check(step, ran, short(got, 1500), pass);
const ask = (callId: string) => ({ callId, tool: 'exec', args: { command: `echo ${callId}` }, category: 'execute',
  analysis: { classification: 'command', riskLevel: 'medium', summary: `Run echo ${callId}`, reasons: [] } });

const group = await startGroup(['j16-a', 'j16-b', 'j16-c'], { judgment: 'off' });
const [a, b, c] = group.nodes as [typeof group.nodes[0], typeof group.nodes[0], typeof group.nodes[0]];
const listOn = async (node: typeof a, id: string): Promise<ApprovalRow | undefined> =>
  ((await api(node.daemon, node.token, 'GET', '/api/approvals')).body as OperatorMethodOutput<'approvals.list'>).approvals?.find((row) => row.id === id);
const raiseOn = async (node: typeof a, callId: string): Promise<Raised> =>
  (await invoke(node.daemon, node.token, 'approvals.raise', { request: ask(callId), timeoutMs: 600_000 })).body as Raised;

try {
  // 1, 2
  const raised = await raiseOn(a, 'j16-one');
  const id = raised.approvalId as string;
  const started = Date.now();
  const onB = await waitFor(async () => listOn(b, id), 20_000, 100);
  check('B lists A\'s ask as waiting for an approver, home reachable', 'GET /api/approvals on B',
    { ms: Date.now() - started, reading: onB?.reading },
    onB?.homeNode === a.nodeId && onB?.reading?.reason === 'waiting-for-approver' && onB?.reading?.waitingOn?.homeReachable === true);
  const inboxB = (await invoke(b.daemon, b.token, 'inbox.list', {})).body as Inbox;
  check('B\'s inbox names it <id>@A', 'inbox.list on B', inboxB.items?.map((item) => item.id),
    inboxB.items?.some((item) => item.id === `${id}@${a.nodeId}`) === true);

  // 3
  const approved = (await api(b.daemon, b.token, 'POST', `/api/approvals/${encodeURIComponent(`${id}@${a.nodeId}`)}/approve`,
    { expectedRevision: onB?.revision })).body as ApprovalAnswer;
  check('B approves at the revision it read; A applies it', 'POST approve on B', approved,
    approved.applied === true && approved.approval?.status === 'approved' && String(approved.reading?.decision?.by ?? '').endsWith(`@${b.nodeId}`));
  const onA = await listOn(a, id);
  check('A\'s record: decided through B, its asker not yet confirmed', 'GET /api/approvals on A', onA?.reading,
    onA?.reading?.decision?.surface === `node:${b.nodeId}` && onA?.reading?.receipt?.state === 'waiting');

  // 4
  const released = (await api(a.daemon, a.token, 'POST', `/api/approvals/${id}/cancel`, { release: true, holdId: raised.holdId })).body as ApprovalAnswer;
  const sameOnB = await waitFor(async () => {
    const row = await listOn(b, id);
    return row?.reading?.receipt?.state === 'delivered' ? row : undefined;
  }, 5_000, 100);
  const aFinal = await listOn(a, id);
  const strip = (reading: ApprovalRow['reading'] | undefined) => reading && { ...reading, allowedActions: undefined, refusedActions: undefined, waitingOn: undefined, deadline: undefined };
  check('A and B read the same decision and receipt', 'GET /api/approvals on A and B', { a: aFinal?.reading, b: sameOnB?.reading },
    released.applied === true && JSON.stringify(strip(aFinal?.reading)) === JSON.stringify(strip(sameOnB?.reading)) && sameOnB?.reading?.phase === 'decided');

  // 5
  const late = (await api(a.daemon, a.token, 'POST', `/api/approvals/${id}/approve`, { expectedRevision: aFinal?.revision })).body as ApprovalAnswer;
  check('a late approve through A is APPROVAL_SETTLED', 'POST approve on A', late, late.applied === false && late.refusal?.code === 'APPROVAL_SETTLED');

  // 6
  const second = await raiseOn(a, 'j16-two');
  const secondId = second.approvalId as string;
  const secondOnB = await waitFor(async () => listOn(b, secondId), 20_000, 100);
  process.kill(a.daemon.pid, 'SIGSTOP');
  const stoppedAt = Date.now();
  const unknown = (await api(b.daemon, b.token, 'POST', `/api/approvals/${encodeURIComponent(`${secondId}@${a.nodeId}`)}/deny`,
    { expectedRevision: secondOnB?.revision })).body as ApprovalAnswer;
  const took = Date.now() - stoppedAt;
  process.kill(a.daemon.pid, 'SIGCONT');
  check('with A paused, B answers NODE_UNREACHABLE (unknown) within about 5 s', 'POST deny on B while A is stopped', { took, unknown },
    unknown.applied === false && unknown.refusal?.code === 'NODE_UNREACHABLE' && unknown.refusal?.state === 'unknown' && took < 7_000);
  await Bun.sleep(1_500);
  const actualOnA = await listOn(a, secondId);
  const readOnB = await waitFor(async () => {
    const row = await listOn(b, secondId);
    return row?.sequence === actualOnA?.sequence ? row : undefined;
  }, 10_000, 200);
  check('once A runs again, B reads A\'s actual outcome', 'GET /api/approvals on A and B', { a: actualOnA?.status, b: readOnB?.status },
    readOnB !== undefined && readOnB.status === actualOnA?.status);

  // 7
  const fromC = await raiseOn(c, 'j16-three');
  const cId = fromC.approvalId as string;
  const seenOnA = await waitFor(async () => listOn(a, cId), 20_000, 100);
  const third = await raiseOn(a, 'j16-four');
  const thirdId = third.approvalId as string;
  const thirdOnC = await waitFor(async () => listOn(c, thirdId), 20_000, 100);
  const forgot = await api(a.daemon, a.token, 'POST', '/api/cluster/forget', { nodeId: c.nodeId });
  const dropped = await waitFor(async () => (await listOn(a, cId)) === undefined ? true : undefined, 10_000, 200);
  check('C removed: A no longer lists C\'s approvals', 'POST /api/cluster/forget on A', { forgot: forgot.status, seenBefore: Boolean(seenOnA), dropped },
    forgot.status < 300 && seenOnA !== undefined && dropped === true);
  const fromRemoved = (await api(c.daemon, c.token, 'POST', `/api/approvals/${encodeURIComponent(`${thirdId}@${a.nodeId}`)}/approve`,
    { expectedRevision: thirdOnC?.revision ?? 1 })).body as ApprovalAnswer;
  const stillOnA = await listOn(a, thirdId);
  check('A refuses a decide from the removed C; nothing changes', 'POST approve on C', { c: fromRemoved.refusal?.code, a: stillOnA?.status },
    fromRemoved.applied !== true && stillOnA?.status === 'pending');

  // 8
  const fourth = await raiseOn(a, 'j16-five');
  const fourthId = fourth.approvalId as string;
  const fourthOnB = await waitFor(async () => listOn(b, fourthId), 20_000, 100);
  const decided = (await api(b.daemon, b.token, 'POST', `/api/approvals/${encodeURIComponent(`${fourthId}@${a.nodeId}`)}/deny`,
    { expectedRevision: fourthOnB?.revision })).body as ApprovalAnswer;
  await a.restart({ crash: true });
  const afterRestart = await listOn(a, fourthId);
  check('A restarted after the decision: the receipt is waiting', 'GET /api/approvals on A after a crash', afterRestart?.reading?.receipt,
    decided.applied === true && afterRestart?.status === 'denied' && afterRestart?.reading?.receipt?.state === 'waiting');
  const releasedAfter = (await api(a.daemon, a.token, 'POST', `/api/approvals/${fourthId}/cancel`, { release: true, holdId: fourth.holdId })).body as ApprovalAnswer;
  check('after the release the receipt is delivered', 'POST cancel release on A', releasedAfter.reading?.receipt,
    releasedAfter.applied === true && releasedAfter.reading?.receipt?.state === 'delivered');
} catch (error) {
  journey.check('journey ran', '', String(error instanceof Error ? error.stack : error), false);
} finally {
  await group.close();
}
journey.finish(group.base);

/**
 * Journey 2: delegated work.
 *
 *  - In both headless products the model spawns a worker agent: the worker
 *    runs its own model turn and tools, its result comes back as the run's
 *    answer, and the stream reports the agent;
 *  - the daemon's fleet lists the worker;
 *  - a contract started on the daemon (contracts.start) either runs or says
 *    plainly why it cannot with decision models off, and what the daemon holds
 *    about it survives a daemon restart.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENTRY, TUI_ENTRY, Journey, api, approvePending, framesOf, invoke, nativeTurnStatus, operatorToken, permissionAnswerer, runProduct, sendNativeHostedTurn, short, stage, waitFor } from './lib.ts';

const journey = new Journey('j2-delegation');
const s = await stage('j2');
const ws = s.home.workspace;
const approveAll = permissionAnswerer(() => true);

try {
  await s.registerWorkspace();
  const agentIds: string[] = [];
  for (const [product, entry] of [['tui', TUI_ENTRY], ['agent', AGENT_ENTRY]] as const) {
    const tag = product.toUpperCase();
    const main = `RTJ2${tag}MAIN`;
    const work = `RTJ2${tag}WORK`;
    const file = `worker-${product}.txt`;
    s.model.script(main, [
      { calls: [{ name: 'agent', args: { mode: 'spawn', outsideContract: true, task: `${work} write ${file} containing done` } }] },
      { text: 'The worker is on it.' },
      { text: 'The worker wrote the file.' },
    ]);
    s.model.script(work, [
      { calls: [{ name: 'write', args: { files: [{ path: file, content: 'done\n' }] } }] },
      { text: `Worker report: ${file} written.` },
    ]);
    const run = await runProduct(s.home, entry, ['run', '--output', 'stream-json', '--omit-accumulated', '--answer-permissions', `${main} have a worker write ${file}`],
      { onLine: approveAll, timeoutMs: 180_000 });
    const final = run.frames.at(-1) ?? {};
    const completed = framesOf(run, 'AGENT_COMPLETED');
    const workerRequests = s.model.requests.filter((entry) => entry.marker === work);
    for (const frame of completed) if (typeof frame.agentId === 'string') agentIds.push(frame.agentId);
    journey.check(`${product}: the spawned worker ran its own model turn and tool`, `${product} run --answer-permissions "${main} ..." (agent spawn, outsideContract)`,
      `exit ${run.code}; worker model requests ${workerRequests.length} with ${workerRequests[0]?.toolNames.length ?? 0} tools; ${file}: ${existsSync(join(ws, file)) ? JSON.stringify(readFileSync(join(ws, file), 'utf8')) : 'missing'}`,
      run.code === 0 && workerRequests.length >= 2 && existsSync(join(ws, file)) && readFileSync(join(ws, file), 'utf8') === 'done\n');
    journey.check(`${product}: the worker's result comes back`, 'final frame and AGENT_* frames',
      `response ${short(final.response, 200)}; frames ${JSON.stringify(run.frames.map((frame) => frame.type).filter((type) => String(type).startsWith('AGENT_')))}`,
      completed.length === 1 && /worker-|Worker report|wrote the file/.test(String(final.response)) && final.ok === true);
  }

  // A worker of a daemon-hosted session shows in the daemon's fleet (what the apps and the web UI list).
  const token = operatorToken(s.home);
  s.model.script('RTJ2HOSTMAIN', [
    { calls: [{ name: 'agent', args: { mode: 'spawn', outsideContract: true, task: 'RTJ2HOSTWORK write hosted-worker.txt containing done' } }] },
    { text: 'The worker is on it.' }, { text: 'Done.' }, { text: 'Done.' },
  ]);
  s.model.script('RTJ2HOSTWORK', [
    { delayMs: 4_000, calls: [{ name: 'write', args: { files: [{ path: 'hosted-worker.txt', content: 'done\n' }] } }] },
    { text: 'Hosted worker report: written.' },
  ]);
  // Sent the way the web UI and the attached Agent send a message: native intake, then a hosted turn.
  const hostedTurn = await sendNativeHostedTurn(s.daemon, token, 'RTJ2HOSTMAIN have a worker write hosted-worker.txt');
  const approvedHere: Array<Record<string, unknown>> = [];
  const seen = await waitFor(async () => {
    approvedHere.push(...await approvePending(s.daemon, token));
    const fleet = await invoke(s.daemon, token, 'fleet.list');
    const items = ((fleet.body as { items?: Array<Record<string, unknown>> }).items ?? []).filter((item) => item.kind === 'agent' || String(item.id ?? '').startsWith('agent-'));
    return items.length > 0 ? items : undefined;
  }, 30_000);
  journey.check('a hosted session\'s worker shows in the daemon fleet while it runs', 'native hosted turn (capture, admit, turn/start) that spawns a worker; owner approves in the approvals list; fleet.list',
    `turn/start ${hostedTurn.start.status} ${short(hostedTurn.start.text, 160)}; approved ${JSON.stringify(approvedHere.map((entry) => (entry.request as { tool?: string } | undefined)?.tool))}; fleet agents ${short(seen ?? [], 300)}`,
    hostedTurn.start.status === 200 && seen !== undefined && seen.length > 0);
  const hostedFile = await waitFor(async () => { await approvePending(s.daemon, token); return existsSync(join(ws, 'hosted-worker.txt')) ? true : undefined; }, 30_000);
  const turnState = await nativeTurnStatus(s.daemon, token, hostedTurn);
  journey.check('the hosted worker finishes its work', 'wait for hosted-worker.txt; workLedger.turn.status', `file ${hostedFile === true}; turn ${short(turnState, 200)}`, hostedFile === true);

  // A contract started on the daemon.
  const started = await api(s.daemon, token, 'POST', '/api/contracts', { ask: 'RTJ2CONTRACT write contract-a.txt and contract-b.txt', workspaceRoot: ws, idempotencyKey: 'rt-j2-contract' });
  const contract = started.body as { contract?: { id?: string; status?: string }; id?: string; status?: string; error?: string; code?: string };
  const contractId = contract.contract?.id ?? contract.id;
  void agentIds;
  journey.check('a contract started on the daemon runs, or says why it cannot', 'POST /api/contracts { ask, workspaceRoot }',
    `${started.status} ${short(started.text, 500)}`,
    (started.status === 200 || started.status === 201) && typeof contractId === 'string'
    || (started.status === 409 && (started.body as { code?: string }).code === 'DECISION_MODELS_DISABLED' && /decision model/i.test(started.text)));
  if (typeof contractId === 'string') {
    await s.restartDaemon();
    const again = await api(s.daemon, operatorToken(s.home), 'GET', `/api/contracts/${encodeURIComponent(contractId)}`);
    journey.check('the contract survives a daemon restart', `restart the daemon; GET /api/contracts/${contractId}`, `${again.status} ${short(again.text, 300)}`,
      again.status === 200 && again.text.includes(contractId));
  }
} catch (error) {
  journey.check('journey ran to the end', 'j2', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
}
journey.finish(s.base);

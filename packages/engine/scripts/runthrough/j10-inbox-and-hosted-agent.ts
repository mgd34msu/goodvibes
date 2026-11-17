/**
 * Journey 10: the owner inbox across two apps, and an Agent tool in a
 * daemon-hosted Agent session.
 *
 *  - in `goodvibes-agent run` the model leaves the owner a question with the
 *    query tool; it is in the daemon's owner inbox;
 *  - the owner answers it in the terminal app: the real TUI runs in a
 *    pseudo-terminal (pty.ts) on the same daemon, and the owner types
 *    /questions, reads the question's id from the list and types
 *    /questions answer <id> green;
 *  - the Agent hears the answer: its next run in that session (--continue)
 *    carries it to the model;
 *  - a daemon-hosted Agent session (originSurface agent) runs an Agent tool
 *    (agent_knowledge status) and gets its result.
 */
import { readFileSync } from 'node:fs';
import { AGENT_ENTRY, TUI_ENTRY, Journey, approvePending, invoke, nativeTurnStatus, operatorToken, permissionAnswerer, runProduct, sendNativeHostedTurn, short, stage, waitFor } from './lib.ts';
import { textOf } from './fake-model.ts';
import { openTerminalApp } from './pty.ts';

const journey = new Journey('j10-inbox-and-hosted-agent');
const s = await stage('j10');

/** The env runProduct gives a product, for an app started in a pseudo-terminal: every port already listening that is not this journey's is denied. */
function terminalEnv(): Record<string, string> {
  const own = new Set<number>([...s.home.allowed, ...Object.values(s.home.ports), s.model.port, Number(new URL(s.daemon.baseUrl).port)]);
  const listening = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let table = '';
    try { table = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && fields[1]) listening.add(parseInt(fields[1].split(':').at(-1) ?? '0', 16));
    }
  }
  return { ...s.home.env, RUNTHROUGH_DENY_PORTS: [...listening].filter((port) => !own.has(port)).join(',') };
}
const approveAll = permissionAnswerer(() => true);

try {
  const owner = operatorToken(s.home);
  await s.registerWorkspace();
  const ask = { calls: [{ name: 'query', args: { mode: 'ask', question: 'RTJ10 which colour should the release banner be?', options: ['green', 'blue'], key: 'rt-banner' } }] };
  // query may be offered as a one-line entry: the first call loads it and is sent again.
  s.model.script('RTJ10ASK', [ask, ask, { text: 'I asked the owner and carried on.' }]);
  const asked = await runProduct(s.home, AGENT_ENTRY, ['run', '--output', 'stream-json', '--answer-permissions', 'RTJ10ASK pick a banner colour, ask me if unsure'], { onLine: approveAll });
  const item = await waitFor(async () => {
    const listed = await invoke(s.daemon, owner, 'inbox.list', {});
    return ((listed.body as { items?: Array<Record<string, unknown>> }).items ?? []).find((entry) => String(entry.title ?? '').includes('release banner'));
  }, 10_000);
  journey.check('a question the Agent asks reaches the owner inbox', 'goodvibes-agent run: model calls query { mode: ask }; inbox.list',
    `exit ${asked.code}; tool results ${short(s.model.toolResults('RTJ10ASK').map((entry) => entry.content), 240)}; inbox item ${short(item ?? 'none', 240)}`,
    asked.code === 0 && item !== undefined);

  if (item) {
    // The owner answers in the TUI, with keystrokes, in a pseudo-terminal.
    const tui = openTerminalApp([process.execPath, '--no-env-file', TUI_ENTRY], { cwd: s.home.workspace, env: terminalEnv() });
    let listed: RegExpMatchArray | null = null, replied: RegExpMatchArray | null = null;
    try {
      await tui.waitFor(/\S{3,}/, 20_000);
      await Bun.sleep(4_000);
      let mark = tui.raw().length;
      await tui.type('/questions');
      tui.press('\r');
      listed = await tui.waitFor(/(\S+)\s+question\s+RTJ10 which colour should the release banner be\?/, 20_000, mark);
      if (listed) {
        mark = tui.raw().length;
        await tui.type(`/questions answer ${listed[1]} green`);
        tui.press('\r');
        replied = await tui.waitFor(/\[inbox\] (Answered [^\n]*?green[^\n]{0,80}|[^\n]{0,160})/, 20_000, mark);
      }
    } finally {
      await tui.close();
    }
    const after = ((await invoke(s.daemon, owner, 'inbox.list', { status: 'all' })).body as { items?: Array<Record<string, unknown>> }).items ?? [];
    const answeredItem = after.find((entry) => entry.id === item.id);
    const answer = answeredItem?.answer as { option?: string } | undefined;
    journey.check('the owner answers it in the TUI with keystrokes', 'goodvibes (TUI) in a pseudo-terminal: type /questions, then /questions answer <id> green; inbox.list',
      `listed ${listed ? `id ${listed[1]}` : `no; screen ${short(tui.screen().slice(-600), 600)}`}; reply ${short(replied?.[0] ?? 'none', 200)}; item ${answeredItem?.status} ${JSON.stringify(answer ?? null)} by ${short(answeredItem?.answeredBy ?? 'nobody', 120)}`,
      listed !== null && /Answered/.test(replied?.[0] ?? '') && answeredItem?.status === 'answered' && answer?.option === 'green');
    s.model.script('RTJ10NEXT', [{ text: 'Green it is.' }]);
    const next = await runProduct(s.home, AGENT_ENTRY, ['run', '--continue', '--output', 'stream-json', '--answer-permissions', 'RTJ10NEXT go on with the banner'], { onLine: approveAll });
    const request = s.model.requests.find((entry) => entry.marker === 'RTJ10NEXT');
    const heard = (request?.messages ?? []).some((message) => /green/i.test(textOf(message.content)) && /banner|question|answer/i.test(textOf(message.content)) && message.role !== 'assistant');
    journey.check('the Agent hears the answer in its next run of that session', 'goodvibes-agent run --continue "RTJ10NEXT ..."',
      `exit ${next.code}; answer in the model request ${heard}`, next.code === 0 && heard);
  }

  // A daemon-hosted Agent session uses an Agent tool.
  const status = { calls: [{ name: 'agent_knowledge', args: { action: 'status' } }] };
  s.model.script('RTJ10HOSTED', [status, status, { text: 'Knowledge is ready.' }]);
  // As the Agent attached to the daemon sends a message: native intake, then an Agent hosted turn.
  const turn = await sendNativeHostedTurn(s.daemon, owner, 'RTJ10HOSTED how is my knowledge?', undefined, true);
  const created = turn.start;
  const done = await waitFor(async () => { await approvePending(s.daemon, owner); const state = await nativeTurnStatus(s.daemon, owner, turn); return state.state === 'completed' || state.state === 'failed' ? state : undefined; }, 30_000);
  const results = s.model.toolResults('RTJ10HOSTED');
  const last = results.at(-1)?.content ?? '';
  journey.check('a daemon-hosted Agent session runs an Agent tool', 'native intake + workLedger.turn.startAgent; the model calls agent_knowledge { action: status }',
    `create ${created.status}; turn ${short(done ?? 'running', 160)}; offered ${s.model.requests.find((entry) => entry.marker === 'RTJ10HOSTED')?.toolNames.includes('agent_knowledge')}; last result ${short(last, 240)}`,
    created.status === 200 && done?.state === 'completed' && results.length >= 1 && last.length > 0 && !/^Error/.test(last));
} catch (error) {
  journey.check('journey ran to the end', 'j10', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
}
journey.finish(s.base);

/**
 * Journey 9: crash recovery in both headless products.
 *
 * A run is killed (SIGKILL) while a command it started is running; the next
 * `run --continue` restores the session from its crash snapshot before its
 * first request, says what it recovered (SESSION_RECOVERED and the final
 * frame's `recovery`), and the model sees the interrupted call as interrupted,
 * never as a success.
 */
import { AGENT_ENTRY, Journey, TUI_ENTRY, framesOf, permissionAnswerer, runProduct, short, stage } from './lib.ts';
import { textOf } from './fake-model.ts';

const journey = new Journey('j9-crash-recovery');
const s = await stage('j9');
const approveAll = permissionAnswerer(() => true);

try {
  await s.registerWorkspace();
  for (const [product, entry] of [['tui', TUI_ENTRY], ['agent', AGENT_ENTRY]] as const) {
    const tag = product.toUpperCase();
    const first = `RTJ9${tag}FIRST`;
    s.model.script(first, [{ calls: [{ name: 'exec', args: { commands: [{ cmd: 'sleep 20' }] } }] }, { text: 'never reached' }]);
    let killed = false;
    const crashed = await runProduct(s.home, entry, ['run', '--output', 'stream-json', '--answer-permissions', `${first} run the long job`], {
      onLine(line, child) {
        approveAll(line, child);
        if (!killed && line.includes('TOOL_EXECUTING')) { killed = true; setTimeout(() => child.kill('SIGKILL'), 6_000); }
      },
      timeoutMs: 60_000,
    });
    journey.check(`${product}: a run is killed while its command runs`, `${product} run "${first} ..." then SIGKILL 6 s after TOOL_EXECUTING`,
      `killed ${killed}; exit ${crashed.code}`, killed && crashed.code !== 0);

    const next = `RTJ9${tag}NEXT`;
    s.model.script(next, [{ text: 'Picking up where we left off.' }]);
    const resumed = await runProduct(s.home, entry, ['run', '--continue', '--output', 'stream-json', '--answer-permissions', `${next} what happened?`], { onLine: approveAll });
    const recoveredFrame = framesOf(resumed, 'SESSION_RECOVERED')[0];
    const final = resumed.frames.at(-1) ?? {};
    const recovery = final.recovery as { applied?: boolean; interruptedTurn?: { interruptedToolCalls?: Array<{ tool?: string }> } } | undefined;
    const request = s.model.requests.find((entry) => entry.marker === next);
    const toolMessages = (request?.messages ?? []).filter((message) => message.role === 'tool').map((message) => textOf(message.content));
    const interruptedSeen = toolMessages.some((text) => /interrupt|unknown|cancel/i.test(text) && !/"success":true/.test(text));
    journey.check(`${product}: --continue restores the session and says what it recovered`, `${product} run --continue "${next} ..."`,
      `exit ${resumed.code}; SESSION_RECOVERED ${short(recoveredFrame ?? 'none', 220)}; recovery ${short(recovery ?? 'none', 220)}`,
      resumed.code === 0 && recoveredFrame !== undefined && recovery?.applied === true
      && (recovery.interruptedTurn?.interruptedToolCalls ?? []).some((call) => call.tool === 'exec'));
    journey.check(`${product}: the model sees the earlier prompt and the interrupted call as interrupted`, 'the first model request of the resumed run',
      `earlier prompt present ${(request?.messages ?? []).some((message) => message.role === 'user' && textOf(message.content).includes(first))}; tool messages ${short(toolMessages, 300)}`,
      request !== undefined && (request.messages ?? []).some((message) => message.role === 'user' && textOf(message.content).includes(first)) && interruptedSeen);
  }
} catch (error) {
  journey.check('journey ran to the end', 'j9', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
}
journey.finish(s.base);

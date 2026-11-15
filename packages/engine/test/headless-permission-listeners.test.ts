import { expect, test } from 'bun:test';
import { createHeadlessPermissionInput, observeHeadlessTurn } from '../terminal-shell/src/native/headless-turn-events.ts';

function countingSignal() {
  const controller = new AbortController();
  const { signal } = controller;
  let attached = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => { attached += 1; add(type, listener, options); }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => { attached -= 1; remove(type, listener, options); }) as typeof signal.removeEventListener;
  return { signal, controller, attached: () => attached };
}
function source() {
  const data = new Set<(chunk: string) => void>();
  return {
    on: (event: string, listener: (chunk: string) => void) => { if (event === 'data') data.add(listener); },
    off: (event: string, listener: (chunk: string) => void) => { if (event === 'data') data.delete(listener); },
    write: (text: string) => { for (const listener of data) listener(text); },
  };
}
const request = (callId: string) => ({ callId, tool: 'bash', category: 'exec', analysis: { riskLevel: 'high', summary: 'run it' } }) as never;

test('answered prompts leave no abort listeners on the run or execution signals', async () => {
  const run = countingSignal(); const execution = countingSignal(); const input = source();
  const answers = createHeadlessPermissionInput({ input: input as never, emit: () => {}, signal: run.signal });
  for (let n = 0; n < 20; n += 1) {
    const decision = answers.prompt(request(`c${n}`), { signal: execution.signal } as never);
    input.write(`{"type":"PERMISSION_ANSWER","callId":"c${n}","approved":true}\n`);
    expect(await decision).toEqual({ approved: true, remember: false });
  }
  expect(run.attached()).toBe(0);
  expect(execution.attached()).toBe(0);
  const pending = answers.prompt(request('late'), { signal: execution.signal } as never);
  execution.controller.abort();
  expect((await pending).approved).toBe(false);
  expect(run.attached()).toBe(0);
});

test('a second prompt under a waiting call id is refused and the first stays answerable', async () => {
  const run = countingSignal(); const input = source();
  const answers = createHeadlessPermissionInput({ input: input as never, emit: () => {}, signal: run.signal });
  const first = answers.prompt(request('same'));
  const second = await answers.prompt(request('same'));
  expect(second.approved).toBe(false);
  expect(second.reason).toContain('still waiting');
  input.write('{"type":"PERMISSION_ANSWER","callId":"same","approved":true}\n');
  expect((await first).approved).toBe(true);
});

test('free text forwarded to scripts is masked and bounded', () => {
  const frames: unknown[] = [];
  const listeners = new Map<string, (envelope: { payload: Record<string, unknown>; source: string }) => void>();
  const bus = { on: (type: string, listener: never) => { listeners.set(type, listener); return () => {}; } };
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { frames.push(JSON.parse(chunk)); return true; }) as typeof process.stdout.write;
  try {
    observeHeadlessTurn(bus as never, 'stream-json', 'unsettled');
    const token = `ghp_${'a'.repeat(36)}`;
    listeners.get('TOOL_FAILED')?.({ payload: { type: 'TOOL_FAILED', turnId: 't', callId: 'c', tool: 'bash', durationMs: 1, error: `curl -H "Authorization: ${token}" failed ${'x'.repeat(5000)}` }, source: 'orchestrator' });
  } finally { process.stdout.write = realWrite; }
  const frame = frames[0] as { error: string };
  expect(frame.error).not.toContain('ghp_aaaa');
  expect(frame.error.length).toBeLessThan(1100);
});

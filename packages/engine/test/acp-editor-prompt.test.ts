// Proves: An editor driving `goodvibes acp` gets no answer to a prompt, cannot send a second one, or is told a model failure is a refusal or nothing at all.
// Red when: The embedded daemon stops reading the terminal app's settings and providers, or a prompt is started as something other than one agent answering it (a contract whose owner record runs no model), so the prompt is never answered, the next is refused as still running, or a failed run ends without saying it failed.
/**
 * The real ACP agent (acp/agent.ts) over the real embedded session and the
 * real daemon it boots in a scratch home, set up the way a person sets up the
 * terminal app: a model and a provider file under `~/.goodvibes/tui`. Only the
 * model is a stand-in, on loopback at the HTTP wire; the editor's side is the
 * connection's two calls, recorded.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoodVibesAcpAgent } from '../platform/src/platform/acp/agent.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';

const root = mkdtempSync(join(tmpdir(), 'gv-acp-prompt-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** The model: answers each prompt by its text, and refuses the key for the one that must fail. */
const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'standin-model', object: 'model', context_length: 128000 }] });
  if (!path.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
  const body = await request.json() as { messages: { role: string; content: unknown }[] };
  // What the editor asked now: the turn's own `[Host]` note for this request (core/host-instructions.ts) is not it, and the
  // message before it carries the whole recent transcript ("User: ..." and "Assistant: ..." turns), of which only the last
  // turn is the newest prompt; an earlier prompt in the transcript must not decide the answer.
  const said = (content: unknown): string => (typeof content === 'string' ? content : Array.isArray(content)
    ? content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('') : '');
  const carried = said(body.messages.filter((message) => message.role === 'user' && !said(message.content).trimStart().startsWith('[Host]')).at(-1)?.content);
  const asked = carried.split(/\n+(?=(?:User|Assistant): )/).at(-1) ?? '';
  if (asked.includes('Fail this one')) return Response.json({ error: { message: 'the key was refused', type: 'invalid_request_error' } }, { status: 401 });
  const text = asked.includes('Say it again') ? 'Again from the stand-in.' : 'Hello from the stand-in.';
  const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'standin-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return new Response(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
} });
afterAll(() => { void model.stop(true); });

test("an editor's prompt is answered, the next one too, and a model failure ends the prompt as a failure", async () => {
  const home = join(root, 'home'), project = join(home, 'project');
  mkdirSync(join(home, '.goodvibes', 'tui', 'providers'), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, '.goodvibes', 'tui', 'providers', 'standin.json'), JSON.stringify({
    name: 'standin', displayName: 'Stand-in', type: 'openai-compat', baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'stand-in-placeholder',
    models: [{ id: 'standin-model', displayName: 'Stand-in', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }],
  }));
  writeFileSync(join(home, '.goodvibes', 'tui', 'settings.json'), JSON.stringify({ provider: { model: 'standin:standin-model', refreshListsAtStart: false }, permissions: { mode: 'yolo' } }));
  seedBenchmarkCache(home, 'goodvibes');

  const said: string[] = [];
  const agent = new GoodVibesAcpAgent({
    sessionUpdate: async ({ update }) => { if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') said.push(update.content.text); },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }, { homeDirectory: home });
  try {
    const { sessionId } = await agent.newSession({ cwd: project, mcpServers: [] });
    const prompt = async (text: string) => {
      said.length = 0;
      const ended = await agent.prompt({ sessionId, prompt: [{ type: 'text', text }] })
        .then((response) => ({ stopReason: response.stopReason as string, error: null }), (error: unknown) => ({ stopReason: null, error: String(error) }));
      return { ...ended, said: said.join('') };
    };

    expect(await prompt('Say hello.')).toEqual({ stopReason: 'end_turn', error: null, said: 'Hello from the stand-in.' });
    expect(await prompt('Say it again.')).toEqual({ stopReason: 'end_turn', error: null, said: 'Again from the stand-in.' });
    // The newest prompt decides the stand-in's answer, though an earlier one in the transcript says otherwise.
    expect(await prompt('Say hello.')).toEqual({ stopReason: 'end_turn', error: null, said: 'Hello from the stand-in.' });
    const failed = await prompt('Fail this one.');
    expect({ stopReason: failed.stopReason, failedWith401: /^Error: The run failed: .*401/.test(failed.error ?? '') }).toEqual({ stopReason: null, failedWith401: true });
  } finally {
    await agent.dispose();
  }
});

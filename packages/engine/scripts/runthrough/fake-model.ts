/**
 * A scripted conversation model on the HTTP wire: an OpenAI-compatible
 * `/v1/chat/completions` (streamed) and `/v1/models` on 127.0.0.1. The
 * products reach it through a custom provider file, exactly as they would
 * reach a real compatible endpoint.
 *
 * A journey registers a script under a marker word its prompt starts with (a
 * host note that only quotes the marker does not claim the request).
 * The step of the script is the number of assistant messages that follow the
 * last user message carrying the marker, so a step is answered again the same
 * way if the product retries. A request no script claims gets a short text
 * answer and is recorded as unclaimed.
 */
export interface ScriptedCall { readonly name: string; readonly args: Record<string, unknown> }
export interface ScriptedReply {
  readonly text?: string;
  readonly calls?: readonly ScriptedCall[];
  /** Hold the response this long before the first byte (to cancel or kill mid-turn). */
  readonly delayMs?: number;
}
export interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_calls?: ReadonlyArray<{ id: string; function: { name: string; arguments: string } }>;
  readonly tool_call_id?: string;
}
export interface RecordedRequest {
  readonly at: number;
  readonly marker: string | null;
  readonly step: number;
  readonly messages: readonly ChatMessage[];
  readonly toolNames: readonly string[];
  readonly parallelToolCalls: unknown;
  readonly system: string;
  readonly replied: ScriptedReply;
}
export type Script = (step: number, messages: readonly ChatMessage[], toolNames: readonly string[]) => ScriptedReply | undefined;

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('');
  return '';
}

export interface FakeModel {
  readonly port: number;
  readonly baseURL: string;
  readonly requests: RecordedRequest[];
  /** The full tool definitions of the last request that carried tools. */
  readonly lastTools: () => ReadonlyArray<{ function?: { name?: string; description?: string; parameters?: unknown } }>;
  script(marker: string, script: Script | readonly ScriptedReply[]): void;
  /** Tool results the model received for a marker, in message order. */
  toolResults(marker: string): Array<{ id: string; name: string; content: string }>;
  stop(): void;
}

let callCounter = 0;

function sse(data: unknown): string { return `data: ${JSON.stringify(data)}\n\n`; }

function streamReply(reply: ScriptedReply, model: string): string {
  const id = `chatcmpl-rt-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  let out = sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  if (reply.text) {
    for (const piece of reply.text.match(/.{1,40}/gs) ?? []) out += sse({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  }
  const calls = reply.calls ?? [];
  calls.forEach((call, index) => {
    const callId = `call_rt_${++callCounter}`;
    out += sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] });
  });
  out += sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }] });
  out += sse({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  out += 'data: [DONE]\n\n';
  return out;
}

export function startFakeModel(modelId = 'rt-1'): FakeModel {
  const scripts = new Map<string, Script>();
  const requests: RecordedRequest[] = [];
  let lastTools: ReadonlyArray<{ function?: { name?: string; description?: string; parameters?: unknown } }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: modelId, object: 'model', owned_by: 'runthrough', context_length: 200000 }] });
      }
      if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
      const body = await request.json() as { messages?: ChatMessage[]; tools?: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>; parallel_tool_calls?: unknown; stream?: boolean; model?: string };
      const messages = body.messages ?? [];
      if (body.tools && body.tools.length > 0) lastTools = body.tools;
      const toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? '').filter(Boolean);
      let marker: string | null = null;
      let lastUser = -1;
      for (let index = messages.length - 1; index >= 0 && marker === null; index--) {
        const message = messages[index]!;
        if (message.role !== 'user') continue;
        const text = textOf(message.content);
        // The longest marker the message starts with, so RTX and RTXY never claim each other's prompts.
        for (const key of scripts.keys()) if (text.trimStart().startsWith(key) && key.length > (marker?.length ?? 0)) { marker = key; lastUser = index; }
      }
      const step = marker === null ? 0 : messages.slice(lastUser + 1).filter((message) => message.role === 'assistant').length;
      const script = marker === null ? undefined : scripts.get(marker);
      const reply = script?.(step, messages, toolNames) ?? { text: marker === null ? 'Noted.' : 'Done.' };
      const system = messages.filter((message) => message.role === 'system' || message.role === 'developer').map((message) => textOf(message.content)).join('\n');
      requests.push({ at: Date.now(), marker, step, messages, toolNames, parallelToolCalls: body.parallel_tool_calls, system, replied: reply });
      if (reply.delayMs) {
        const aborted = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), reply.delayMs);
          request.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(true); }, { once: true });
        });
        if (aborted) return new Response('aborted', { status: 499 });
      }
      const payload = streamReply(reply, body.model ?? modelId);
      if (body.stream === false) {
        const calls = (reply.calls ?? []).map((call) => ({ id: `call_rt_${++callCounter}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }));
        return Response.json({ id: 'chatcmpl-rt', object: 'chat.completion', created: 0, model: body.model ?? modelId, choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? '', ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      }
      return new Response(payload, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    },
  });
  const port = server.port!;
  return {
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    lastTools: () => lastTools,
    script(marker, script) {
      scripts.set(marker, typeof script === 'function' ? script : (step) => script[step]);
    },
    toolResults(marker) {
      const last = [...requests].reverse().find((entry) => entry.marker === marker);
      if (!last) return [];
      const names = new Map<string, string>();
      for (const message of last.messages) for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
      return last.messages.filter((message) => message.role === 'tool').map((message) => ({ id: message.tool_call_id ?? '', name: names.get(message.tool_call_id ?? '') ?? '', content: textOf(message.content) }));
    },
    stop() { server.stop(true); },
  };
}

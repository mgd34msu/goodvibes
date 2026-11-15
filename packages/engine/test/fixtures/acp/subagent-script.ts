/** Synthetic stdio ACP peer scripted by argv[2]. No providers, environment reads or credentials. */
const mode = process.argv[2] ?? 'text:20';
const send = (message: unknown) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const chunk = (text: string) => ({
  jsonrpc: '2.0', method: 'session/update',
  params: { sessionId: 'script-session', update: { sessionUpdate: 'agent_message_chunk', content: mode === 'array-chunk' ? [{ type: 'text', text }] : { type: 'text', text } } },
});
if (mode === 'hang') {
  process.stdin.on('data', () => {});
  setInterval(() => {}, 60_000);
} else {
  async function handle(message: Record<string, unknown>) {
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    } else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'script-session' } });
    else if (message.method === 'session/prompt') {
      const [kind, arg] = mode.split(':');
      if (kind === 'text') {
        const total = Number(arg);
        // Distinct head and tail so truncation of either end is visible.
        send(chunk(`HEAD${'x'.repeat(Math.max(total - 8, 0))}TAIL`));
      } else send(chunk('the answer'));
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: kind === 'stop' ? arg : 'end_turn' } });
    }
  }
  let buffered = '';
  for await (const bytes of Bun.stdin.stream()) {
    buffered += new TextDecoder().decode(bytes);
    for (;;) {
      const at = buffered.indexOf('\n'); if (at < 0) break;
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      if (line.trim()) await handle(JSON.parse(line) as Record<string, unknown>);
    }
  }
}

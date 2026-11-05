import { expect, test } from 'bun:test';

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} cancels a CLI-owned transport that ignores fetch cancellation`, async () => {
    const owner = new URL('../scripts/process-owner.ts', import.meta.url).href;
    const foundation = new URL('../src/index.ts', import.meta.url).href;
    const child = Bun.spawn([process.execPath, '-e', `
      import { judgmentProcessSignal } from ${JSON.stringify(owner)};
      import { createSystemOnePort, noul } from ${JSON.stringify(foundation)};
      const keepAlive = setInterval(() => {}, 1000);
      const port = createSystemOnePort({ signal: judgmentProcessSignal(),
        endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' },
        model: 'jev-latest', timeoutMs: 0, retry: {},
        fetch: async () => { console.log('ready'); return new Promise(() => {}); } });
      try { await port.ask({ state: 'fixture', questions: { yes: noul('Fixture?') } }); process.exitCode = 1; }
      catch (error) { console.log(error.kind); if (error.kind !== 'aborted') process.exitCode = 1; }
      finally { clearInterval(keepAlive); }
    `], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
      child.kill(signal);
      expect(await child.exited).toBe(0);
      let remaining = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        remaining += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      expect(remaining).toContain('aborted');
      expect(await new Response(child.stderr).text()).toBe('');
    } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
  }, 5000);
}

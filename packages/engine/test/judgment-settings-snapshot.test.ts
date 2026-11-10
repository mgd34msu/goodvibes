import { describe, expect, test } from 'bun:test';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { noul } from '@goodvibes-jev/judgment';
import { createSettingsJudgmentPort, judgmentConfigFromSettings, type JudgmentSettingsSource } from '../platform/src/platform/runtime/judgment-services.ts';

const request = { state: { fixture: 'settings reload' }, questions: { allowed: noul('Is this allowed?') }, context: { site: 'test.settings-reload' } };
function fixture(keySource: 'env' | 'secret' = 'secret') {
  const settings: Record<string, unknown> = {
    'judgment.endpoint': 'https://old.example.test', 'judgment.model': 'jev-1.13.0',
    'judgment.keySource': keySource, 'judgment.timeoutMs': 1000,
  };
  const env: Record<string, string | undefined> = { TYPESAFE_API_KEY: 'synthetic-old-key' };
  const key = Promise.withResolvers<string | null>();
  const source: JudgmentSettingsSource = { config: { get: (name) => settings[name] }, env, secrets: { get: () => key.promise } };
  return { settings, env, key, source };
}
function endpoint(failFirst = false) {
  const calls: { key: string | null; model: string }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(input) {
    const body = await input.json() as { model: string };
    calls.push({ key: input.headers.get('authorization'), model: body.model });
    if (failFirst && calls.length === 1) return new Response('', { status: 503 });
    return Response.json({ model: body.model, answers: { allowed: { type: 'noul', noul: 0.01 } }, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

describe('judgment settings reload captures one configuration per call', () => {
  test('an unowned call is refused before a secret lookup can strand it', async () => {
    const { source } = fixture(); let reads = 0;
    const port = createSettingsJudgmentPort({ ...source, secrets: { get: () => {
      reads++; return new Promise<string | null>(() => {});
    } } });
    await expect(port.ask(request)).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(reads).toBe(0);
  }, 1000);

  test.each(['scalar', 'pending', 'rejected', 'thenable'] as const)('the settings adapter preserves refusal and drains a nonvoid %s attempt guard before any target dispatch', async kind => {
    const target = endpoint(), { settings, source } = fixture('env');
    settings['judgment.endpoint'] = target.url;
    settings['judgment.fallbacks'] = [{ endpoint: target.url, model: 'jev-1.13.0', keySource: 'none', keyName: '' }];
    const controller = new AbortController(), late = Promise.withResolvers<void>();
    let checks = 0, thenReads = 0;
    const value = (): unknown => kind === 'scalar' ? true : kind === 'pending' ? late.promise
      : kind === 'rejected' ? Promise.reject(new Error('Synthetic asynchronous guard refusal'))
      : { get then() { thenReads++; throw new Error('Borrowed then must not execute'); } };
    try {
      await expect(createSettingsJudgmentPort(source).ask({ ...request, signal: controller.signal,
        beforeAttempt() { checks++; return value(); },
      })).rejects.toMatchObject({ kind: 'invalid-request' });
      if (kind === 'pending') late.reject(new Error('Synthetic late guard rejection'));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(checks).toBe(1); expect(thenReads).toBe(0); expect(target.calls).toHaveLength(0);
    } finally { controller.abort(); target.stop(); }
  });

  test.each(['cancellation', 'policy'] as const)('a synchronous settings attempt guard cannot conceal its own %s change before dispatch', async changed => {
    const target = endpoint(), { settings, source } = fixture('env'); settings['judgment.endpoint'] = target.url;
    const controller = new AbortController(); let policy = 'Default - On';
    try {
      await withDecisionModelPolicy(() => policy, async () => {
        await expect(createSettingsJudgmentPort(source).ask({ ...request, signal: controller.signal, beforeAttempt() {
          if (changed === 'cancellation') controller.abort(); else policy = 'Classic - Off';
        } })).rejects.toMatchObject({ kind: changed === 'cancellation' ? 'aborted' : 'rejected' });
      });
      expect(target.calls).toHaveLength(0);
    } finally { controller.abort(); target.stop(); }
  });

  test('a pending secret read cannot pair its old key with a new endpoint or model', async () => {
    const { settings, env, key, source } = fixture();
    const pending = judgmentConfigFromSettings(source);
    settings['judgment.endpoint'] = 'https://new.example.test';
    settings['judgment.model'] = 'jev-2.0.0';
    settings['judgment.timeoutMs'] = 2000;
    settings['judgment.keySource'] = 'env';
    env.TYPESAFE_API_KEY = 'synthetic-new-key';
    key.resolve('synthetic-old-secret');
    expect(await pending).toMatchObject({ endpoint: { baseURL: 'https://old.example.test', apiKey: 'synthetic-old-secret' }, model: 'jev-1.13.0', timeoutMs: 1000 });
    expect(await judgmentConfigFromSettings(source)).toMatchObject({ endpoint: { baseURL: 'https://new.example.test', apiKey: 'synthetic-new-key' }, model: 'jev-2.0.0', timeoutMs: 2000 });
  });

  test('environment defaults are captured with the settings before key acquisition yields', async () => {
    const { settings, env, source } = fixture('env');
    settings['judgment.endpoint'] = ''; settings['judgment.model'] = '';
    env.TYPESAFE_BASE_URL = 'https://old.example.test'; env.TYPESAFE_DEFAULT_MODEL = 'jev-1.13.0';
    const pending = judgmentConfigFromSettings(source);
    settings['judgment.endpoint'] = 'https://new.example.test'; settings['judgment.model'] = 'jev-2.0.0';
    settings['judgment.timeoutMs'] = 2000;
    env.TYPESAFE_API_KEY = 'synthetic-new-key'; env.TYPESAFE_BASE_URL = 'https://other.example.test'; env.TYPESAFE_DEFAULT_MODEL = 'jev-3.0.0';
    expect(await pending).toMatchObject({ endpoint: { baseURL: 'https://old.example.test', apiKey: 'synthetic-old-key' }, model: 'jev-1.13.0', timeoutMs: 1000 });
  });

  test('a secret resolver cannot synchronously redirect its acquired credential', async () => {
    const { settings, source } = fixture();
    const config = await judgmentConfigFromSettings({ ...source, secrets: { async get() {
      settings['judgment.endpoint'] = 'https://new.example.test';
      return 'synthetic-old-secret';
    } } });
    expect(config.endpoint).toMatchObject({ baseURL: 'https://old.example.test', apiKey: 'synthetic-old-secret' });
  });

  test('concurrent calls send each captured key only to its own endpoint even when secrets resolve out of order', async () => {
    const old = endpoint(); const next = endpoint();
    const { settings, key, source } = fixture();
    settings['judgment.endpoint'] = old.url;
    const port = createSettingsJudgmentPort(source);
    const abort = new AbortController();
    const first = port.ask({ ...request, signal: abort.signal });
    try {
      settings['judgment.endpoint'] = next.url; settings['judgment.keySource'] = 'env'; settings['judgment.model'] = 'jev-2.0.0';
      const second = await port.ask({ ...request, signal: abort.signal });
      expect(second.requestedModel).toBe('jev-2.0.0');
      key.resolve('synthetic-old-secret');
      expect((await first).requestedModel).toBe('jev-1.13.0');
      await port.ask({ ...request, signal: abort.signal });
      expect(old.calls).toEqual([{ key: 'Bearer synthetic-old-secret', model: 'jev-1.13.0' }]);
      expect(next.calls).toEqual(Array.from({ length: 2 }, () => ({ key: 'Bearer synthetic-old-key', model: 'jev-2.0.0' })));
    } finally { abort.abort(); key.resolve('synthetic-old-secret'); await first.catch(() => {}); old.stop(); next.stop(); }
  });

  test('a hot reload affects new readings while configured failover preserves the pending reading', async () => {
    const old = endpoint(true); const next = endpoint();
    const { settings, env, source } = fixture('env'); settings['judgment.endpoint'] = old.url;
    settings['judgment.fallbacks'] = [{ endpoint: old.url, model: 'jev-1.13.0', keySource: 'env', keyName: 'TYPESAFE_API_KEY' }];
    const port = createSettingsJudgmentPort(source); const waiting = Promise.withResolvers<void>(); const abort = new AbortController();
    const first = port.ask({ ...request, signal: abort.signal, onRetry: () => waiting.resolve() });
    try {
      await waiting.promise;
      settings['judgment.endpoint'] = next.url; settings['judgment.model'] = 'jev-2.0.0'; env.TYPESAFE_API_KEY = 'synthetic-new-key';
      const second = await port.ask({ ...request, signal: abort.signal });
      const initial = await first;
      expect(initial.lineage?.attempts.map((attempt) => attempt.outcome)).toEqual(['unavailable', 'answered']);
      expect(second.lineage?.attempts.map((attempt) => attempt.outcome)).toEqual(['answered']);
      expect(old.calls).toEqual(Array.from({ length: 2 }, () => ({ key: 'Bearer synthetic-old-key', model: 'jev-1.13.0' })));
      expect(next.calls).toEqual([{ key: 'Bearer synthetic-new-key', model: 'jev-2.0.0' }]);
      expect(initial.answers.allowed).toEqual({ type: 'noul', noul: 0.01 });
    } finally { abort.abort(); await first.catch(() => {}); old.stop(); next.stop(); }
  });
});


describe('configured transport owns Preferred exhaustion', () => {
  function unavailableEndpoint(status: number) {
    let calls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      calls++;
      return status === 200 ? Response.json({ model: 'jev-1.13.0', answers: { allowed: { type: 'noul', noul: 'malformed' } } })
        : new Response('', { status });
    } });
    return { url: `http://127.0.0.1:${server.port}`, calls: () => calls, stop: () => server.stop(true) };
  }

  test('a feature translating the exhausted error cannot lose the operation fallback', async () => {
    const primary = unavailableEndpoint(503), secondary = unavailableEndpoint(503);
    const { settings, source } = fixture('env');
    settings['judgment.endpoint'] = primary.url;
    settings['judgment.fallbacks'] = [{ endpoint: secondary.url, model: 'jev-1.13.0', keySource: 'none', keyName: '' }];
    const port = createSettingsJudgmentPort(source), controller = new AbortController();
    try {
      await withDecisionModelPolicy(() => 'Preferred', async () => {
        let kind: unknown;
        try { await port.ask({ ...request, signal: controller.signal }); }
        catch (error) { kind = error instanceof Error && 'kind' in error ? error.kind : undefined; }
        expect(kind).toBe('unavailable');
        expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
        await expect(port.ask({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'decision-models-disabled' });
        expect(primary.calls()).toBe(1); expect(secondary.calls()).toBe(1);
      });
    } finally { controller.abort(); primary.stop(); secondary.stop(); }
  });

  test('a malformed answer followed by an unavailable fallback is not availability exhaustion', async () => {
    const primary = unavailableEndpoint(200), secondary = unavailableEndpoint(503);
    const { settings, source } = fixture('env');
    settings['judgment.endpoint'] = primary.url;
    settings['judgment.fallbacks'] = [{ endpoint: secondary.url, model: 'jev-1.13.0', keySource: 'none', keyName: '' }];
    const port = createSettingsJudgmentPort(source), controller = new AbortController();
    try {
      await withDecisionModelPolicy(() => 'Preferred', async () => {
        await expect(port.ask({ ...request, signal: controller.signal })).rejects.toMatchObject({ kind: 'invalid-response' });
        expect(decisionModelPolicyState().operation).toBe('decision');
      });
    } finally { controller.abort(); primary.stop(); secondary.stop(); }
  });

  test('a genuine negative reading remains a decision result', async () => {
    const target = endpoint(); const { settings, source } = fixture('env'); settings['judgment.endpoint'] = target.url;
    const port = createSettingsJudgmentPort(source), controller = new AbortController();
    try {
      await withDecisionModelPolicy(() => 'Preferred', async () => {
        const result = await port.ask({ ...request, signal: controller.signal });
        expect(result.answers.allowed).toEqual({ type: 'noul', noul: 0.01 });
        expect(decisionModelPolicyState().operation).toBe('decision');
      });
    } finally { controller.abort(); target.stop(); }
  });

  test('Classic prevents even credential acquisition and the first wire attempt', async () => {
    const target = endpoint(); const { settings, source } = fixture(); settings['judgment.endpoint'] = target.url;
    let credentialReads = 0;
    const port = createSettingsJudgmentPort({ ...source, secrets: { async get() { credentialReads++; return null; } } });
    const controller = new AbortController();
    try {
      await withDecisionModelPolicy(() => 'Classic - Off', async () => {
        await expect(port.ask({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'decision-models-disabled' });
      });
      expect(credentialReads).toBe(0); expect(target.calls).toHaveLength(0);
    } finally { controller.abort(); target.stop(); }
  });
});

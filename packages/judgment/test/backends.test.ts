import { describe, expect, test } from 'bun:test';
import { captureJudgmentBackendSettings, choice, createSystemOnePort, DECISION_MODEL_PROFILES, noul,
  type JudgmentConfig, type JudgmentEndpoint } from '../src/index.ts';

const state = { task: 'Find the definition of loadConfig', files: ['config.ts'] };
const questions = { yes: noul('Does this request concern source code?') };
const result = (model: string, extra = {}) => ({ model, answers: { yes: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 19, output_tokens: 2 }, ...extra });
const configured = (endpoint: JudgmentEndpoint, model: string, fetch: NonNullable<JudgmentConfig['fetch']>): JudgmentConfig => ({
  endpoint, model, fetch, timeoutMs: 30, retry: {}, signal: new AbortController().signal,
});

describe('decision backend protocol conformance', () => {
  for (const profile of DECISION_MODEL_PROFILES) {
    test(`${profile.name} preserves the complete typed request and actual model usage`, async () => {
      const cloudflare = profile.adapter === 'cloudflare-workers-ai';
      const endpoint: JudgmentEndpoint = cloudflare
        ? { kind: 'hosted', baseURL: `https://api.cloudflare.com/client/v4/accounts/test/ai/run/@cf/cloudflare/${profile.model}`, apiKey: 'fixture-key' }
        : { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none', adapter: profile.adapter,
          ...(profile.responseModels === undefined ? {} : { responseModels: profile.responseModels }) };
      let calls = 0;
      const port = createSystemOnePort(configured(endpoint, profile.model, async (url, init) => {
        calls++;
        expect(String(url)).toBe(cloudflare ? endpoint.baseURL : `${endpoint.baseURL}/v1/systemone`);
        expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).get('authorization')).toBe(cloudflare ? 'Bearer fixture-key' : null);
        expect(JSON.parse(String(init?.body))).toEqual({ model: profile.model, state, questions });
        const body = result(profile.responseModels?.[0] ?? profile.model, profile.adapter === 'laya' ? { usage: { input_tokens: 19, output_tokens: 2, truncated: false } } : {});
        return Response.json(cloudflare ? { success: true, errors: [], messages: [], result: body } : body);
      }));
      const answer = await port.ask({ state, questions });
      expect(answer.answers.yes.noul).toBe(0.8);
      expect(answer.model).toBe(profile.responseModels?.[0] ?? profile.model);
      expect(answer.usage).toEqual({ inputTokens: 19, outputTokens: 2 });
      expect(calls).toBe(1);
    });
  }

  test('Laya uses its declared Jev confidence rather than reinterpreting native entropy', async () => {
    const endpoint: JudgmentEndpoint = { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none', adapter: 'laya' };
    const port = createSystemOnePort(configured(endpoint, 'english', async () => Response.json({
      model: 'english', answers: { category: { type: 'choice', choice: 'code', probabilities: { code: 0.9, other: 0.1 }, confidence: 0.53, x_jev_confidence: 0.8 } },
      usage: { input_tokens: 20, output_tokens: 0, truncated: false },
    })));
    const answer = await port.ask({ state, questions: { category: choice('Choose the category', { code: 'Source code', other: 'Other' }) } });
    expect(answer.answers.category.confidence).toBe(0.8);
  });

  test.each(['clef', 'clef-flash'])('Cloudflare %s keeps its adapter and model when the run URL has a trailing slash', async model => {
    const endpoint: JudgmentEndpoint = { kind: 'hosted',
      baseURL: `https://api.cloudflare.com/client/v4/accounts/test/ai/run/@cf/cloudflare/${model}/`, apiKey: 'fixture-key' };
    let calls = 0;
    const port = createSystemOnePort(configured(endpoint, model, async (url, init) => {
      calls++;
      expect(String(url)).toBe(endpoint.baseURL.slice(0, -1));
      expect(JSON.parse(String(init?.body))).toEqual({ model, state, questions });
      return Response.json({ success: true, result: result(model) });
    }));
    expect((await port.ask({ state, questions })).model).toBe(model);
    expect(calls).toBe(1);
  });

  test('Cloudflare rejects overlong complete input locally and can fall back without shortening it', async () => {
    const endpoint: JudgmentEndpoint = { kind: 'hosted', baseURL: 'https://api.cloudflare.com/client/v4/accounts/test/ai/run/@cf/cloudflare/clef', apiKey: 'fixture-key' };
    const complete = '完整 evidence '.repeat(5000);
    let calls = 0;
    const config = configured(endpoint, 'clef', async (url, init) => {
      calls++;
      expect(String(url)).toBe('http://127.0.0.1:9000/v1/systemone');
      expect(JSON.parse(String(init?.body)).state).toBe(complete);
      return Response.json(result('jev-latest'));
    });
    const port = createSystemOnePort({ ...config, fallbacks: [{ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none' }, model: 'jev-latest' }] });
    const answer = await port.ask({ state: complete, questions });
    expect(answer.model).toBe('jev-latest'); expect(calls).toBe(1);
    expect(answer.lineage?.attempts.map(attempt => attempt.outcome)).toEqual(['invalid-request', 'answered']);
  });

  test('four-decimal distributions retain their supplied precision through the adapter', async () => {
    const endpoint: JudgmentEndpoint = { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none', adapter: 'laya' };
    const port = createSystemOnePort(configured(endpoint, 'english', async () => Response.json({ model: 'english',
      answers: { category: { type: 'choice', choice: 'a', confidence: 0, x_jev_confidence: 0,
        probabilities: { a: 0.3333, b: 0.3333, c: 0.3333 } } },
      usage: { input_tokens: 20, output_tokens: 0, truncated: false },
    })));
    const answer = await port.ask({ state, questions: { category: choice('Choose', { a: 'First', b: 'Second', c: 'Third' }) } });
    expect(answer.answers.category.probabilities).toEqual({ a: 0.3333, b: 0.3333, c: 0.3333 });
  });

  test.each([{ truncated: true }, { truncated: 2 }, { state_tokens_dropped: 1 }, { truncated_questions: ['yes'] }])('rejects incomplete evidence reported as %j', async flags => {
    const endpoint: JudgmentEndpoint = { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none' };
    const port = createSystemOnePort(configured(endpoint, 'custom-model', async () => Response.json(result('custom-model', {
      usage: { input_tokens: 19, output_tokens: 2, ...flags },
    }))));
    await expect(port.ask({ state, questions })).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  test.each(['yes', false, null, {}, [null], [1]])('malformed truncated question metadata %j falls back with the complete original input', async truncated_questions => {
    const primary: JudgmentEndpoint = { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none' };
    const seen: unknown[] = [];
    const config = configured(primary, 'first', async (url, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json(String(url).includes(':9000/')
        ? result('first', { usage: { input_tokens: 19, output_tokens: 2, truncated_questions } }) : result('second'));
    });
    const port = createSystemOnePort({ ...config, fallbacks: [{
      endpoint: { ...primary, baseURL: 'http://127.0.0.1:9001' }, model: 'second',
    }] });
    const answer = await port.ask({ state, questions });
    expect(answer.model).toBe('second');
    expect(seen).toEqual([{ model: 'first', state, questions }, { model: 'second', state, questions }]);
    expect(answer.lineage?.attempts.map(attempt => attempt.outcome)).toEqual(['invalid-response', 'answered']);
  });

  test('only declared deployment aliases may change the returned model identity', async () => {
    const aliases = ['kev-9b-v1'];
    const endpoint: JudgmentEndpoint = { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none', responseModels: aliases };
    const port = createSystemOnePort(configured(endpoint, 'kev-latest', async () => Response.json(result('kev-9b-v1'))));
    aliases[0] = 'changed';
    expect((await port.ask({ state, questions })).model).toBe('kev-9b-v1');
  });

  test('capability snapshots reject getters without invoking them and detach aliases', () => {
    let invoked = 0;
    const hostile = Object.defineProperty({}, 'adapter', { enumerable: true, get() { invoked++; return 'laya'; } });
    expect(() => captureJudgmentBackendSettings(hostile)).toThrow(); expect(invoked).toBe(0);
    const aliases = ['english']; const captured = captureJudgmentBackendSettings({ adapter: 'laya', responseModels: aliases });
    aliases[0] = 'changed'; expect(captured.responseModels).toEqual(['english']); expect(Object.isFrozen(captured.responseModels)).toBe(true);
  });
});

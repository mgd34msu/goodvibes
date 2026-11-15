import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { normalizeLocalBaseUrl, stripUrlCredentials } from '../../tools/agent-harness-local-model-url.ts';
import { localModelServerEndpoints, localModelServerFacts, localModelServerHealthMap } from '../../tools/agent-harness-local-model-endpoints.ts';
import { runLocalModelServerSmoke } from '../../tools/agent-harness-local-model-smoke.ts';
import { localModelBenchmarkHistoryFrom, localModelBenchmarkPlan, type LocalModelBenchmarkSnapshot } from '../../tools/agent-harness-local-model-benchmarks.ts';
import { localModelProviderRoutes } from '../../tools/agent-harness-local-model-cookbook.ts';
import type { LocalModelRecipe } from '../../tools/agent-harness-model-routing-types.ts';
import { localEndpointSmokeRoute, localProviderAddRoute } from '../../tools/agent-harness-local-model-endpoints.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a record.');
  return Object.fromEntries(Object.entries(value));
}

function readings() {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name === 'kind') return choiceAnswer(question, 'other', 0.999);
    if (name === 'identifying' || name === 'lineHasCredential' || name === 'spanIsCredential' || name === 'credentialRemains') return noulAnswer(0.001);
    if (name === 'route') return choiceAnswer(question, record(state).evidence_kind === 'probe' ? 'llamacpp' : 'openai-compatible', 0.999);
    if (name === 'status') return choiceAnswer(question, 'ready', 0.999);
    if (name === 'pressure') return choiceAnswer(question, 'low', 0.999);
    if (name === 'boolean_value') return choiceAnswer(question, 'false', 0.999);
    if (name === 'certified') return noulAnswer(0.001);
    throw new Error(`Unexpected local model fixture question ${name}`);
  });
}

function contextFor(baseURL: string, extra: { readonly provider?: Record<string, unknown>; readonly readModels?: Record<string, unknown> } = {}) {
  const provider = { id: 'synthetic-local', baseURL, description: 'Synthetic local server', ...extra.provider };
  const model = { providerId: 'synthetic-local', registryKey: 'synthetic-local:m', modelId: 'm', baseURL, description: 'Synthetic route' };
  return { provider: { providerRegistry: { listProviders: () => [provider], listModels: () => [model] } },
    clients: { providerApi: { listProviderIds: () => ['synthetic-local'] } },
    platform: extra.readModels ? { readModels: extra.readModels } : {} } as unknown as CommandContext;
}

const owner = () => ({ sourceOwner: ordinaryResearchOwner() });

describe('base URLs never carry a credential into model-visible output', () => {
  test('normalizing and stripping remove userinfo', () => {
    expect(normalizeLocalBaseUrl('http://u:pw@127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1');
    expect(stripUrlCredentials('http://u:pw@127.0.0.1:1234/v1/models')).toBe('http://127.0.0.1:1234/v1/models');
    expect(stripUrlCredentials('not a url')).toBe('not a url');
  });

  test('an endpoint taken from an environment variable with userinfo yields ids and commands without it', () => {
    const previousEnv = process.env.LITELLM_BASE_URL;
    process.env.LITELLM_BASE_URL = 'http://svc:hunter2@127.0.0.1:4000';
    try {
      const facts = localModelServerFacts(contextFor('http://127.0.0.1:8080/v1'), true);
      expect(JSON.stringify(facts.endpoints)).toContain('127.0.0.1:4000');
      expect(JSON.stringify(facts)).not.toContain('hunter2');
    } finally {
      if (previousEnv === undefined) delete process.env.LITELLM_BASE_URL; else process.env.LITELLM_BASE_URL = previousEnv;
    }
  });
});

describe('local model smoke stays inside what it checked', () => {
  async function smokeAgainst(baseUrl: string): Promise<Record<string, unknown>> {
    installJudgmentPort(readings().port);
    return runLocalModelServerSmoke(contextFor(baseUrl), { modelRouteId: baseUrl, timeoutMs: 2000 }, owner());
  }

  test('a redirect is reported and never followed to another host', async () => {
    let followed = 0;
    const target = Bun.serve({ port: 0, fetch() { followed++; return Response.json({ data: [{ id: 'elsewhere' }] }); } });
    const redirecting = Bun.serve({ port: 0, fetch() { return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${target.port}/v1/models` } }); } });
    try {
      const result = await smokeAgainst(`http://127.0.0.1:${redirecting.port}/v1`);
      const endpoint = record((result.endpoints as readonly unknown[])[0]);
      expect(followed).toBe(0);
      expect(endpoint.status).toBe('http-error');
      expect(endpoint.httpStatus).toBe(302);
      expect(String(endpoint.failure)).toContain('redirect');
      expect(result.status).not.toBe('ready');
    } finally { redirecting.stop(true); target.stop(true); }
  });

  test('a model id from an untrusted listener is shortened, and an oversized body is not read in full', async () => {
    const longId = 'x'.repeat(10_000);
    const server = Bun.serve({ port: 0, fetch(req) {
      if (new URL(req.url).pathname.endsWith('/big/models')) return new Response(`{"data":[{"id":"a"}],"pad":"${'p'.repeat(1_200_000)}"}`, { headers: { 'content-type': 'application/json' } });
      return Response.json({ data: [{ id: longId }] });
    } });
    try {
      const small = record((record(await smokeAgainst(`http://127.0.0.1:${server.port}/v1`)).endpoints as readonly unknown[])[0]);
      expect(small.status).toBe('passed');
      expect(String((small.sampleModelIds as string[])[0]).length).toBeLessThanOrEqual(80);
      const big = record((record(await smokeAgainst(`http://127.0.0.1:${server.port}/big`)).endpoints as readonly unknown[])[0]);
      expect(big.status).not.toBe('passed');
      expect(String(big.failure)).toContain('not read in full');
    } finally { server.stop(true); }
  });

  test('a target blocked before any request is not-run, at the row and overall', async () => {
    const result = await smokeAgainst('http://0.0.0.0:19876/v1');
    expect(result.status).toBe('blocked');
    expect(result.liveProbe).toBe('not-run');
    expect(record((result.endpoints as readonly unknown[])[0]).liveProbe).toBe('not-run');
    expect(String(result.policy)).toContain('No request was sent');
  });
});

describe('serving diagnostics', () => {
  const diagnostic = { providerId: 'synthetic-local', baseUrl: 'http://127.0.0.1:8080/v1', stack: 'llama.cpp', status: 'healthy', loadedModels: ['m'], summary: 'Synthetic' };
  const producer = (snapshot: unknown) => ({ getSnapshot: () => snapshot });

  test('a timestamp outside the Date range does not hide the record', async () => {
    installJudgmentPort(readings().port);
    const context = contextFor('http://127.0.0.1:8080/v1', { readModels: { models: { servingDiagnostics: producer({ servers: [{ ...diagnostic, lastCheckedAt: 1e18 }] }) } } });
    const result = await localModelServerHealthMap(context, true, owner());
    expect(result.daemonDiagnostics.matchedEndpointCount).toBe(1);
    expect(result.endpoints[0]?.servingDiagnostics?.lastCheckedAt).toBeNull();
  });

  test('a source that cannot be read is named, even when another source supplied records', async () => {
    installJudgmentPort(readings().port);
    const context = contextFor('http://127.0.0.1:8080/v1', { readModels: {
      localModelServers: new Proxy({}, {}), models: { servingDiagnostics: producer({ servers: [diagnostic] }) } } });
    const result = await localModelServerHealthMap(context, true, owner());
    expect(result.daemonDiagnostics.matchedEndpointCount).toBe(1);
    expect(result.daemonDiagnostics.missingSignals.join(' ')).toContain('could not be read from: context.platform.readModels.localModelServers');
  });
});

describe('endpoint discovery agrees between startup and inspection', () => {
  test('a URL that only appears in a provider env var counts in both', async () => {
    installJudgmentPort(readings().port);
    const context = contextFor('http://127.0.0.1:8080/v1', { provider: { envVars: ['http://127.0.0.1:4000/v1'] } });
    const startup = localModelServerFacts(context, false).endpointCount;
    const inspected = await localModelServerEndpoints(context, false, owner());
    expect(startup).toBe(2);
    expect(inspected).toHaveLength(startup);
  });
});

describe('benchmark history', () => {
  const comparison = (index: number) => ({ id: `art-${index}`, filename: `cmp-${index}.json`, createdAt: 1_000 + index,
    metadata: { purpose: 'agent-model-compare', benchmarkKind: 'local-model-route', completedCandidates: 2 } });

  test('counts come from everything read, only the listing is shortened, and a full page is flagged', () => {
    const snapshot = { storeAvailable: true, windowFull: true, comparisons: [0, 1, 2, 3, 4].map(comparison), judgments: [], stacks: [], membership: [] } as unknown as LocalModelBenchmarkSnapshot;
    const history = localModelBenchmarkHistoryFrom(snapshot, false);
    expect(history.count).toBe(3);
    expect(history.total).toBe(5);
    expect(history.truncated).toBe(true);
    expect(history.evidence.comparisonCount).toBe(5);
    expect(history.evidence.completedCandidateCount).toBe(10);
    expect(history.evidence.summary).toContain('older benchmark would not appear');
  });
});

describe('routes written for the model', () => {
  test('do not carry a canned user request or a confirm flag', () => {
    for (const route of [localEndpointSmokeRoute('local-127-0-0-1-8080-v1'), localProviderAddRoute('x', null, 'http://127.0.0.1:8080/v1')]) {
      expect(route).not.toContain('confirm:true');
      expect(route).toContain('explicitUserRequest:"<the user request, in their own words>"');
    }
  });


  test('in the benchmark plan and every provider route are also placeholders', () => {
    for (const id of ['ollama', 'llama-cpp', 'vllm', 'lm-studio']) {
      const recipe: LocalModelRecipe = { id, label: id, fit: '', bestFor: '', hardware: '', setup: [], modelExamples: [], cautions: [] };
      const plan = localModelBenchmarkPlan(recipe);
      const routes = [plan.workspaceActionRoute, plan.compareRoute, plan.refreshRoute, ...localModelProviderRoutes(recipe)];
      for (const route of routes) {
        expect(route).toContain('explicitUserRequest:"<the user request, in their own words>"');
        expect(route).not.toContain('confirm:true');
      }
    }
  });
});

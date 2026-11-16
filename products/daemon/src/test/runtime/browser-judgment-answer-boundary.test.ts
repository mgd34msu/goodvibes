import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { composeJudgment } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { AuthenticatedPrincipal } from '@goodvibes-jev/engine/daemon-api';
import { composeBrowserJudgment } from '../../runtime/browser-judgment-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const principal: AuthenticatedPrincipal = { principalId: 'browser-boundary-fixture', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
const ECHO = 'synthetic-provider-echo-of-private-input';
/** A provider registry with one undeclared runtime provider and one catalog provider, the only source the catalog reading uses. */
const catalogSource = { captureProviderCatalogIds: () => ({ providerIds: ['fixture-runtime-provider'], catalogProviderIds: ['fixture-catalog-provider'], assertCurrent() {} }) };
const providers = () => catalogSource;
/** One provider-to-catalog reading through the daemon's own browser route. */
const request = () => ({ protocolVersion: 1, batteryVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.models.catalog-provider-match', input: { providerId: 'fixture-runtime-provider', keys: ['fixture-catalog-provider'] } });

/** A loopback endpoint whose answers carry a field the question never asked for. */
async function fixture(answer: (name: string) => Record<string, unknown>, refuse?: { status: number; body: string }, usage: Record<string, number> = { input_tokens: 1, output_tokens: 1 }) {
  const root = makeOwnedTempDir('browser-answer-boundary'), project = join(root, 'project'); mkdirSync(project);
  const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: project, surfaceRoot: 'daemon',
    sharedTierPath: join(root, 'shared.json'), daemonTierPath: join(root, 'daemon.json') });
  config.set('judgment.keySource', 'env'); config.set('judgment.model', 'jev-1.13.0');
  const secrets = new SecretsManager({ projectRoot: project, globalHome: join(root, 'home'), surfaceRoot: 'daemon', configManager: config });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(incoming) {
    const body = await incoming.json() as { model: string; questions: Record<string, unknown> };
    if (refuse) return new Response(refuse.body, { status: refuse.status });
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(name => [name, answer(name)])),
      usage });
  } });
  config.set('judgment.endpoint', `http://127.0.0.1:${server.port}`);
  const env = { TYPESAFE_API_KEY: 'synthetic-key' };
  const cleanup: (() => void | Promise<void>)[] = [];
  const disposal = { add(_label: string, dispose: () => void | Promise<void>) { cleanup.push(dispose); } };
  const previous = installJudgmentPort(undefined);
  const judgment = composeJudgment({ config, secrets, env, stateRoot: join(root, 'state'), disposal });
  const service = composeBrowserJudgment({ judgment, config, secrets, env, methods: new GatewayMethodCatalog(), providers, disposal });
  installJudgmentPort(undefined);
  return { judgment, service, async close() {
    try { for (const dispose of cleanup.reverse()) await dispose(); } finally { server.stop(true); installJudgmentPort(previous); }
  } };
}

test('a provider refusal that echoes private input is retained without the echo', async () => {
  const f = await fixture(() => ({ type: 'noul', noul: 0.99 }), { status: 400, body: JSON.stringify({ error: { message: ECHO } }) });
  try {
    await expect(f.service.execute(request(), principal, new AbortController().signal, () => principal)).rejects.toBeDefined();
    const entries = f.judgment.decisionLog.query();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.status === 'failed')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(ECHO);
  } finally { await f.close(); }
});

test('a well-formed answer settles through the same route', async () => {
  const f = await fixture(() => ({ type: 'noul', noul: 0.99 }));
  try {
    expect(await f.service.execute(request(), principal, new AbortController().signal, () => principal)).toMatchObject({ status: 'settled', value: { matches: [true] } });
    expect(f.judgment.decisionLog.query({ status: 'answered' })).toHaveLength(1);
  } finally { await f.close(); }
});

test('the browser route admits only the strict answer shape the shared route tolerates', async () => {
  // Fractional token counts are not a shape the browser boundary admits.
  const f = await fixture(() => ({ type: 'noul', noul: 0.99 }), undefined, { input_tokens: 1.5, output_tokens: 1 });
  try {
    await expect(f.service.execute(request(), principal, new AbortController().signal, () => principal))
      .rejects.toMatchObject({ code: 'JUDGMENT_INVALID_RESPONSE' });
    expect(f.judgment.decisionLog.query({ status: 'answered' })).toEqual([]);
  } finally { await f.close(); }
});

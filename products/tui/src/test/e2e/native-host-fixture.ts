/** Owned real daemon, native capture/admission and host-bound paired principal. */
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getProviderModelsCachePath } from '@goodvibes/engine/platform/platform/providers';
import { registerInboxSurface } from '@goodvibes/engine/platform/platform/intake';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath } from '@goodvibes/engine/platform/platform/workspace';
import { startDaemonFixture } from '@goodvibes/daemon/testing';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { beginTuiHostPairing, completeTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { seedBenchmarkCacheFixture } from '../helpers/benchmark-cache-fixture.ts';
import { startScriptedDecisionServer } from '@goodvibes/judgment/testing';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { closeE2EFixture, type E2EHome } from './harness.ts';

/** The decision model's address with the credential it is sent (the fixture's TYPESAFE_API_KEY), in one update as the owner writes it. */
function setDecisionEndpoint(config: { setMany: TuiConfigManager['setMany'] }, endpoint: string, options?: { readonly daemonNotRunning: true }): void {
  const result = config.setMany([{ key: 'judgment.endpoint', value: endpoint }, { key: 'judgment.keySource', value: 'env' }, { key: 'judgment.keyName', value: 'TYPESAFE_API_KEY' }], localOwnerActor(), options);
  if (!result.ok) throw new Error(`E2E decision endpoint was not set: ${result.refusal.reason}`);
}

/**
 * `judgments` is the decision model the program asks (judgment.endpoint and
 * TYPESAFE_BASE_URL); the daemon asks a second one, so what the program asked
 * is counted apart from the daemon's own background readings.
 */
export async function startE2ENativeHost(home: E2EHome) {
  const judgments = startScriptedDecisionServer();
  const daemonJudgments = startScriptedDecisionServer();
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'local-e2e-judgment-fixture-not-a-secret';
  const restore = async () => {
    try { await closeE2EFixture(null, () => judgments.stop(), () => daemonJudgments.stop()); }
    finally {
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
  };
  let daemonOwner: Awaited<ReturnType<typeof startDaemonFixture>> | undefined;
  try {
    const root = join(home.root, 'native-host');
    const daemon = await startDaemonFixture({ root, hostSessions: false,
      configure(configManager) {
        const homeDirectory = join(root, 'home'), workingDirectory = join(root, 'workspace');
        setDecisionEndpoint(configManager, daemonJudgments.baseURL);
        seedProviderMetadataCacheFixture({ configManager, homeDirectory, workingDirectory });
        seedBenchmarkCacheFixture({ homeDirectory, workingDirectory, surfaceRoot: 'goodvibes' });
        const models = getProviderModelsCachePath(configManager.getControlPlaneConfigDir(), 'openai');
        mkdirSync(dirname(models), { recursive: true });
        writeFileSync(models, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, models: [] }));
      },
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    daemonOwner = daemon;
    const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(daemon.services.shellPaths),
      homeDir: daemon.homeDirectory, daemonStateDir: daemon.services.shellPaths.resolveUserPath() });
    await scopes.add(daemon.workingDirectory);
    // Explicit fixture setup follows the production authenticated migration;
    // product startup never creates authority or falls back to this token.
    const migration = await daemon.fetch('/api/control-plane/methods/pairing.tokens.migrate/invoke', {
      method: 'POST', body: JSON.stringify({ body: { name: 'Owned TUI turn E2E principal' } }),
    });
    if (!migration.ok) throw new Error(`E2E native pairing setup failed: ${migration.status}`);
    const paired = (await migration.json() as { token: { token: string; id: string; name: string; createdAt: number } }).token;
    const attempt = { attemptId: crypto.randomUUID(), name: paired.name, startedAt: Date.now() };
    if ((await beginTuiHostPairing(home.home, daemon.baseUrl, attempt)).status !== 'begun') throw new Error('E2E pairing intent was not stored');
    if ((await completeTuiHostPairing(home.home, daemon.baseUrl, attempt.attemptId, {
      token: paired.token, tokenId: paired.id, name: paired.name, createdAt: paired.createdAt,
    })).status !== 'paired') throw new Error('E2E paired authority was not stored');
    const config = new TuiConfigManager({ configDir: join(home.home, '.goodvibes/tui'), homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
    // No daemon runs for this home yet; its settings are written for the daemon to read, as the routed write does then.
    const offline = { daemonNotRunning: true } as const;
    config.set('controlPlane.publicBaseUrl', daemon.baseUrl, offline);
    config.set('daemon.enabled', true, offline);
    config.set('hostedSessions.routeConversationTurns', false, offline);
    setDecisionEndpoint(config, judgments.baseURL, offline);
    return { daemon, judgments, env: { TYPESAFE_API_KEY: 'local-e2e-judgment-fixture-not-a-secret', TYPESAFE_BASE_URL: judgments.baseURL },
      async stop() { await closeE2EFixture(null, () => daemon.stop(), () => judgments.assertNoUnexpected(), () => daemonJudgments.assertNoUnexpected(), restore); },
    };
  } catch (error) {
    try { await closeE2EFixture(null, () => daemonOwner?.stop(), restore); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native host setup and cleanup failed'); }
    throw error;
  }
}

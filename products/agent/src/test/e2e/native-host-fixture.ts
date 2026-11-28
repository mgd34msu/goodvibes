/** A real daemon + paired authority; only external Jev/model replies are synthetic. */
import { dirname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { BenchmarkStore } from '@goodvibes/engine/platform/platform/providers';
import { registerInboxSurface } from '@goodvibes/engine/platform/platform/intake';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath } from '@goodvibes/engine/platform/platform/workspace';
import { startDaemonFixture } from '@goodvibes/daemon/testing';
import { seedProviderMetadataCacheFixture, seedProviderModelListCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { closeE2EFixture, type E2EHome } from './harness.ts';
import { startScriptedDecisionServer } from '@goodvibes/judgment/testing';
import type { DecisionModelPolicy } from '@goodvibes/engine/errors';

export async function startE2ENativeHost(home: E2EHome, options: { readonly policy?: DecisionModelPolicy } = {}) {
  // These fixtures prove local permit delivery. Remote-owner coverage uses a
  // hosted-enabled daemon and must never rely on a failed route falling back.
  home.setDaemonOwnedSetting('hostedSessions.routeConversationTurns', false);
  // The daemon asks its own scripted decision model, so what the binary asked (home.judgments) is counted apart.
  const daemonJudgments = startScriptedDecisionServer();
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'local-e2e-judgment-fixture-not-a-secret';
  const restore = async () => {
    try { await daemonJudgments.stop(); }
    finally {
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
  };
  try {
    // The host has a separate owned home/project: pre-provisioning its workspace
    // authority must not answer the Agent's first-start checkpoint question.
    const daemon = await startDaemonFixture({ root: join(home.root, 'native-host'), hostSessions: false,
      configure(configManager) {
        // The decision model's address with the credential it is sent (the fixture's TYPESAFE_API_KEY), in one update as the owner writes it.
        const decision = configManager.setMany([{ key: 'judgment.endpoint', value: daemonJudgments.baseURL }, { key: 'judgment.keySource', value: 'env' }, { key: 'judgment.keyName', value: 'TYPESAFE_API_KEY' }], localOwnerActor());
        if (!decision.ok) throw new Error(`E2E decision endpoint was not set: ${decision.refusal.reason}`);
        if (options.policy) configManager.set('judgment.policy', options.policy);
        // The paired daemon owns the shared default model (provider.model) and custom providers;
        // mirror the E2E home's scripted stub provider into the daemon fixture so the paired Agent
        // receives e2e-stub:stub-model rather than the unconfigured stock openrouter default.
        const stubSource = join(home.home, '.goodvibes', 'tui', 'providers', 'e2e-stub.json');
        if (existsSync(stubSource)) {
          const daemonProviders = join(home.root, 'native-host', 'home', '.goodvibes', 'tui', 'providers');
          mkdirSync(daemonProviders, { recursive: true });
          copyFileSync(stubSource, join(daemonProviders, 'e2e-stub.json'));
          configManager.set('provider.model', 'e2e-stub:stub-model');
        }
        seedProviderMetadataCacheFixture({ configManager, homeDirectory: join(home.root, 'native-host/home'),
          workingDirectory: join(home.root, 'native-host/workspace'), surfaceRoot: 'goodvibes' });
        seedProviderModelListCacheFixture(configManager, 'openai');
        const cache = new BenchmarkStore({ dir: join(home.root, 'native-host/home/.goodvibes/tui') }).getCachePath();
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
      },
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    try {
      const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(daemon.services.shellPaths),
        homeDir: daemon.homeDirectory, daemonStateDir: daemon.services.shellPaths.resolveUserPath() });
      await scopes.add(daemon.workingDirectory);
      // The daemon fixture has its own separate homeDirectory from the Agent's E2E home, so the
      // Agent's startup registration writes to home.home while the daemon reads native-host/home.
      // Register home.workspace in the daemon fixture's store without touching home.home.
      await scopes.add(home.workspace);
      // This is explicit fixture setup, never product startup or an implicit
      // grant. Exercise the existing authenticated migration route itself.
      const migration = await daemon.fetch('/api/control-plane/methods/pairing.tokens.migrate/invoke', {
        method: 'POST', body: JSON.stringify({ body: { name: 'Owned startup E2E principal' } }),
      });
      if (!migration.ok) throw new Error(`E2E native pairing setup failed: ${migration.status}`);
      const paired = (await migration.json() as { token: { token: string } }).token;
      return { daemon, judgments: daemonJudgments, env: { GOODVIBES_AGENT_RUNTIME_URL: daemon.baseUrl, GOODVIBES_CONNECTED_HOST_TOKEN: paired.token },
        async stop() { await closeE2EFixture(null, () => daemon.stop(), () => daemonJudgments.assertNoUnexpected(), restore); },
      };
    } catch (error) {
      // A failed stop must not replace the setup error that caused it.
      try { await daemon.stop(); } catch { /* the original setup error is the one to report */ }
      throw error;
    }
  } catch (error) { await restore(); throw error; }
}

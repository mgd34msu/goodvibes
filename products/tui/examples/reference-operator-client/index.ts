import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { prepareConfiguredProjectContext } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../src/runtime/services.ts';
import { createRuntimeStore } from '../../src/runtime/store/index.ts';
import { createDirectTransport } from '@/runtime/index.ts';

export async function runReferenceOperatorClientExample(): Promise<void> {
  // A standalone example (not part of the test suite, may run outside this
  // repo entirely), so it stays rooted at the real OS temp dir rather than
  // the test-only makeProjectTempDir helper. Cleaned up in the `finally`
  // below on every exit path.
  const root = mkdtempSync(join(tmpdir(), 'gv-reference-operator-'));
  const workingDir = join(root, 'workspace');
  const homeDir = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  try {
    const configManager = new ConfigManager({
      configDir: join(homeDir, '.goodvibes', 'tui'),
      workingDir,
      homeDir,
    });
    await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-wiki.sqlite', { activate: true });
    const runtimeServices = createRuntimeServices({
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager,
      workingDir,
      homeDirectory: homeDir,
      getConversationTitle: () => 'reference-operator-client',
    });

    try {
      const transport = createDirectTransport(runtimeServices);
      const session = await transport.operator.sessions.ensureSession({
        sessionId: 'reference-operator-session',
        title: 'Reference Operator Session',
        participant: {
          surfaceKind: 'tui',
          surfaceId: 'reference-operator-client',
          lastSeenAt: Date.now(),
        },
      });
      const providers = await transport.operator.providers.snapshot();
      const snapshot = await transport.snapshot();

      console.log(JSON.stringify({
        kind: transport.kind,
        sessionId: session.id,
        providerCount: providers.providerIds.length,
        controlPlaneSessions: snapshot.operator.controlPlane.sessions.length,
        peerContractBasePath: snapshot.peer.nodeHostContract.basePath,
      }, null, 2));
    } finally { await runtimeServices.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runReferenceOperatorClientExample().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

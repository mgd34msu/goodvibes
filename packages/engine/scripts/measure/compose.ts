/**
 * The real client floor (runtime/client-services.ts createClientRuntimeServices)
 * over an isolated home and workspace, with the counting fakes in place of the
 * conversation model and the decision model. Built the way
 * test/hosted-session-turn.test.ts builds it, except that the decision port
 * records to the state root's on-disk decision log as the product's
 * composeJudgment does (runtime/judgment-services.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatResponse } from '../../platform/src/platform/providers/interface.ts';
import { ConfigManager } from '../../platform/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../../platform/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../../platform/src/platform/runtime/store/index.ts';
import { WorkspaceTrustManager } from '../../platform/src/platform/runtime/workspace-trust.ts';
import { createShellPathService } from '../../platform/src/platform/runtime/shell-paths.ts';
import { createClientRuntimeServices, type ClientRuntimeServices } from '../../platform/src/platform/runtime/client-services.ts';
import { openStateDecisionLogWithNotice } from '../../platform/src/platform/state/decision-log.ts';
import type { JudgmentServices } from '../../platform/src/platform/runtime/judgment-services.ts';
import { countingProvider, installCountingJudgment, MODEL, measureModel, PROVIDER, type ExtraRoute } from './fakes.ts';
import type { MeasureEnv } from './harness.ts';

export const SURFACE = 'tui';

export interface Floor {
  readonly services: ClientRuntimeServices;
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  /** Responses the fake model gives next, in order. */
  readonly script: ChatResponse[];
  dispose(): Promise<void>;
}

/** A small workspace: a note, a source tree to find in, a file to edit. */
export function seedWorkspace(workspace: string): void {
  mkdirSync(join(workspace, 'src', 'lib'), { recursive: true });
  writeFileSync(join(workspace, 'note.txt'), 'the file this measurement reads\n');
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(workspace, 'src', `module-${i}.ts`), `export const value${i} = ${i};\n${'// filler line\n'.repeat(40)}`);
  }
  for (let i = 0; i < 4; i++) writeFileSync(join(workspace, 'src', 'lib', `helper-${i}.ts`), `export function helper${i}() { return ${i}; }\n`);
  writeFileSync(join(workspace, 'edit-target.txt'), 'alpha\nbeta\ngamma\n');
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'measure-workspace', version: '1.0.0' }, null, 2));
}

export async function createFloor(env: MeasureEnv, options: { readonly extra?: ExtraRoute } = {}): Promise<Floor> {
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({ surfaceRoot: SURFACE, homeDir: env.home, workingDir: env.workspace });
  const shellPaths = createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home });
  const { log } = openStateDecisionLogWithNotice(shellPaths.resolveProjectPath(SURFACE));
  const judgmentInstall = installCountingJudgment({ log, ...(options.extra ? { extra: options.extra } : {}) });
  const judgment = {
    port: judgmentInstall.port,
    decisionLog: log,
    volumeMonitor: { lastAlert: () => undefined },
  } as unknown as JudgmentServices;
  const workspaceTrust = new WorkspaceTrustManager({
    shellPaths: createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home }),
    surfaceRoot: SURFACE,
  });
  const services = createClientRuntimeServices({
    workspaceTrust,
    configManager,
    runtimeBus,
    runtimeStore: createRuntimeStore(),
    surfaceRoot: SURFACE,
    workingDir: env.workspace,
    homeDirectory: env.home,
    judgment,
    // The terminal products ask the owner here; nothing in these scenarios should reach it.
    requestApproval: async () => ({ approved: true }),
    modelDiscovery: 'skip',
  });
  const script: ChatResponse[] = [];
  services.providerRegistry.registerRuntimeProvider({ provider: countingProvider(script), models: [measureModel()], replace: true });
  services.providerRegistry.setCurrentModel(`${PROVIDER}:${MODEL}`);
  return {
    services, configManager, runtimeBus, script,
    async dispose() {
      judgmentInstall.restore();
      await Promise.resolve(services.dispose());
      log[Symbol.dispose]();
    },
  };
}

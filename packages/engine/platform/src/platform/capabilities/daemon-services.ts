/**
 * The narrow services the daemon hands the capabilities that run there, built
 * from the daemon's own stores. Each capability reads only the ones it names.
 *
 *  - hooks: the hook API over a project's hooks file. The daemon's own
 *    working directory uses the daemon's live workbench and dispatcher (a
 *    change applies to the daemon's turns at once); any other project gets a
 *    workbench of its own over that project's file, applied to nothing here:
 *    the program running turns in that project reads the changed file before
 *    its next hook fires.
 *  - secrets: "All your projects" is the daemon's store, which every program
 *    on this machine reads first; "This project" is the asking program's
 *    project store.
 *  - memory: the one memory store.
 */
import { resolve } from 'node:path';
import type { ConfigManager } from '../config/manager.js';
import { SecretsManager } from '../config/secrets.js';
import { createHookApi, createHookApiDispatcher, type HookApi } from '../hooks/hook-api.js';
import { listHookPointContracts } from '../hooks/contracts.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import { HookWorkbench } from '../hooks/workbench.js';
import { createMemoryApi } from '../knowledge/knowledge-api.js';
import type { MemoryRegistry } from '../state/memory-registry.js';
import type { DaemonCapabilityServices } from './builtin/index.js';

export interface DaemonCapabilityServiceSources {
  readonly configManager: Pick<ConfigManager, 'get' | 'getWorkingDirectory'>;
  readonly hookDispatcher: HookDispatcher;
  readonly hookWorkbench: HookWorkbench;
  readonly secretsManager: SecretsManager;
  readonly memoryRegistry: MemoryRegistry;
}

/** A dispatcher view that runs nothing: a project's file is fired by the program running that project's turns. */
const DETACHED_DISPATCHER = {
  clearLoaded(): void {},
  loadFromFile(): void {},
  listHooks: () => [],
  getChains: () => [],
};

export function createDaemonCapabilityServices(sources: DaemonCapabilityServiceSources): DaemonCapabilityServices {
  const own = createHookApi({
    dispatcher: createHookApiDispatcher(sources.hookDispatcher),
    workbench: sources.hookWorkbench,
    listContracts: () => listHookPointContracts(),
  });
  const projects = new Map<string, HookApi>();
  const hooksFileOf = (directory: string): string => resolve(directory, String(sources.configManager.get('tools.hooksFile')));
  return {
    hooks: {
      forProject(workingDirectory) {
        const daemonDirectory = sources.configManager.getWorkingDirectory();
        if (!workingDirectory || (daemonDirectory && resolve(workingDirectory) === resolve(daemonDirectory))) return own;
        const directory = resolve(workingDirectory);
        let api = projects.get(directory);
        if (!api) {
          const workbench = new HookWorkbench(DETACHED_DISPATCHER, () => hooksFileOf(directory));
          api = createHookApi({ dispatcher: createHookApiDispatcher(DETACHED_DISPATCHER), workbench, listContracts: () => listHookPointContracts() });
          // A few projects at most are managed from one daemon; the oldest is let go past that.
          if (projects.size >= 32) projects.delete(projects.keys().next().value!);
          projects.set(directory, api);
        }
        return api;
      },
    },
    secrets: {
      writerFor(scope, caller) {
        if (scope === 'user') {
          return {
            set: (key, value, options) => sources.secretsManager.set(key, value, options),
            scope: 'daemon',
            where: 'the daemon\'s secret store, which every GoodVibes program on this machine reads first',
          };
        }
        const projectRoot = caller.workingDirectory ? resolve(caller.workingDirectory) : sources.configManager.getWorkingDirectory();
        if (!projectRoot) throw new Error('no project folder was given for a project secret');
        const program = caller.program ?? 'tui';
        const store = new SecretsManager({
          projectRoot, globalHome: sources.secretsManager.getGlobalHome(), surfaceRoot: program,
          configManager: sources.configManager,
        });
        return {
          set: (key, value, options) => store.set(key, value, options),
          scope: 'project',
          where: `the secret store of the project ${projectRoot} that ${program === 'agent' ? 'the Agent' : 'the terminal app'} reads`,
        };
      },
    },
    memory: createMemoryApi(sources.memoryRegistry),
  };
}

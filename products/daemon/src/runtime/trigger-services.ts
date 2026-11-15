import { createTriggerSupervisor, type TriggerManager } from '@goodvibes-jev/engine/platform/platform/triggers';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { AgentManager, ProcessManager } from '@goodvibes-jev/engine/platform/platform/tools';
import type { SharedSessionBroker } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { ShellPathService } from './index.js';

/**
 * The trigger family: stream watchers, on-exit process triggers, and condition
 * checks, supervised as one.
 *
 * This daemon composes the full family and feeds the manager to the fleet as
 * its trigger supervisor, so a trigger defined against the daemon fires
 * reliably. The daemon is the right process to own it, it is the one that
 * stays running. The composition itself (live settings, the process manager
 * behind every command the family runs, the agent manager behind fired turns)
 * is the engine's one `createTriggerSupervisor`.
 */
export function createTriggerServices(deps: {
  readonly configManager: ConfigManager;
  readonly shellPaths: ShellPathService;
  readonly surfaceRoot: string;
  readonly agentManager: AgentManager;
  readonly processManager: ProcessManager;
  readonly sessionBroker: Pick<SharedSessionBroker, 'getSession'>;
}): TriggerManager {
  return createTriggerSupervisor({
    configManager: deps.configManager,
    resolveStorePath: (name) => deps.shellPaths.resolveProjectPath(deps.surfaceRoot, name),
    agents: deps.agentManager,
    processManager: deps.processManager,
    sessionIsLive: (sessionId: string) => deps.sessionBroker.getSession(sessionId) !== null,
  });
}

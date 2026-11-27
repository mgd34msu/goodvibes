/**
 * remote-execution-composition.ts, running work somewhere other than here.
 *
 * Collaborators that only make sense together, so they are built together
 * rather than as unrelated lines in the middle of the runtime composition:
 *
 *   - RemoteRunnerRegistry knows which remote runners exist and how to reach
 *     them; RemoteSupervisor drives them and is meaningless without it.
 *
 *   - SandboxSessionRegistry owns the sandboxes a tool call can be confined to.
 *     The project's tool servers are confined by the same one: the ONE builder
 *     of a project's environment (project-environment.ts) is handed it, so a
 *     server started without it never runs its tools directly on the host.
 *
 * Constructing these opens no connection and starts no server.
 */
import {
  RemoteRunnerRegistry,
} from './remote/runner-registry.js';
import { RemoteSupervisor } from './remote/supervisor.js';
import { SandboxSessionRegistry } from './sandbox/session-registry.js';
import type { AgentManager } from '../tools/index.js';

export interface RemoteExecutionServices {
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
}

/**
 * Build the remote-execution and sandboxing seam.
 *
 * Constructing these opens no connection and starts no server: a runner is
 * reached when something asks for it. Composing a runtime in a test therefore
 * executes nothing.
 */
export function createRemoteExecutionServices(options: {
  readonly agentManager: AgentManager;
  readonly workingDirectory: string;
}): RemoteExecutionServices {
  const remoteRunnerRegistry = new RemoteRunnerRegistry(options.agentManager, options.workingDirectory);
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  const sandboxSessionRegistry = new SandboxSessionRegistry(options.workingDirectory);
  return { remoteRunnerRegistry, remoteSupervisor, sandboxSessionRegistry };
}

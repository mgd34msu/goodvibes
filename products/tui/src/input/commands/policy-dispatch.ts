import type { PolicyCommandContext } from '@goodvibes-jev/engine/platform/platform/gate/policy';
import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';

/** Bind only surface services for `/security`'s policy actions; policy decisions and workflow stay in the engine. */
export function createPolicyCommandContext(context: CommandContext): PolicyCommandContext {
  return {
    print: (text) => context.print(text),
    get policyRuntimeState() { return context.extensions?.policyRuntimeState; },
    workingDirectory: () => requireShellPaths(context).workingDirectory,
    config: () => context.platform.configManager.getAll(),
    listMcpServerSecurity: () => context.extensions.mcpRegistry.listServerSecurity(),
  };
}

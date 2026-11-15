import type { PolicyFrontDoorContext } from '@goodvibes-jev/engine/platform/platform/gate/policy';
import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

/** Bind only surface services; policy decisions and workflow stay in the engine. */
export function createPolicyCommandContext(context: CommandContext): PolicyFrontDoorContext {
  return {
    print: (text) => context.print(text),
    get policyRuntimeState() { return context.extensions?.policyRuntimeState; },
    get policyRegistry() { return context.extensions?.policyRegistry; },
    workingDirectory: () => requireShellPaths(context).workingDirectory,
    config: () => context.platform.configManager.getAll(),
    listMcpServerSecurity: () => context.extensions.mcpRegistry.listServerSecurity(),
    get openPolicyPanel() {
      return context.openPolicyView ? () => context.openPolicyView!() : undefined;
    },
  };
}

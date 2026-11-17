import type { CommandContext } from './command-registry.ts';

export interface AgentWorkspaceConfigReader {
  get(key: string): unknown;
}

export function getAgentWorkspaceConfigReader(context: CommandContext): AgentWorkspaceConfigReader | null {
  const configManager = context.platform.configManager as { get?: unknown } | null | undefined;
  if (!configManager || typeof configManager.get !== 'function') return null;
  const get = configManager.get as (key: string) => unknown;
  return {
    get(key: string): unknown {
      return get.call(configManager, key);
    },
  };
}

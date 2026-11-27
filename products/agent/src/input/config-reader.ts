import type { CommandContext } from './command-registry.ts';

export interface AgentConfigReader {
  get(key: string): unknown;
}

export function getAgentConfigReader(context: CommandContext): AgentConfigReader | null {
  const configManager = context.platform.configManager as { get?: unknown } | null | undefined;
  if (!configManager || typeof configManager.get !== 'function') return null;
  const get = configManager.get as (key: string) => unknown;
  return {
    get(key: string): unknown {
      return get.call(configManager, key);
    },
  };
}

import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import type { McpEntry } from './settings-model-types.js';

export function buildMcpEntries(mcpRegistry: Pick<McpRegistry, 'listServerSecurity'> | null): McpEntry[] {
  if (!mcpRegistry) return [];
  return mcpRegistry.listServerSecurity().map((entry) => ({
    name: entry.name,
    connected: entry.connected,
    role: entry.role,
    trustMode: entry.trustMode,
    allowedPaths: [...entry.allowedPaths],
    allowedHosts: [...entry.allowedHosts],
    ...(entry.toolRules?.length ? { toolRules: entry.toolRules.map((rule) => ({ ...rule })) } : {}),
  }));
}

/** A /mcp action a Settings -> MCP row opens: the command, its action and the blanks already known. */
export interface SettingsGuidedAction {
  readonly command: string;
  readonly action: string;
  readonly values: Readonly<Record<string, string>>;
}

const TOOL_RULE_ACTIONS: Readonly<Record<string, string>> = { block: 'block-tool', unblock: 'unblock-tool', exempt: 'exempt-tool', unexempt: 'unexempt-tool' };

/**
 * `block`, `unblock`, `exempt` or `unexempt` typed on a server's row, with or
 * without a tool: the /mcp action of that word, opened as its guided path
 * with the server (and the tool, when typed) filled in, so it asks the rest
 * and says what it will do before it does it. Null for anything else.
 */
export function mcpGuidedActionFromSettings(serverName: string, text: string): SettingsGuidedAction | null {
  const match = /^(block|unblock|exempt|unexempt)(?:\s+(\S+))?$/i.exec(text.trim());
  if (!match) return null;
  return { command: 'mcp', action: TOOL_RULE_ACTIONS[match[1]!.toLowerCase()]!, values: { server: serverName, ...(match[2] ? { tool: match[2] } : {}) } };
}

/** The words a Settings -> MCP row takes besides a trust mode, for its hint and its refusal. */
export const MCP_TOOL_RULE_EDIT_WORDS = 'block, unblock, exempt or unexempt, with or without a tool';

/**
 * Keep a server's trust mode from Settings -> MCP, the owner's own screen: it
 * applies at once, then is written with the server's entry in its MCP config
 * file so it holds after a restart (allow-all only in the owner's global
 * file). A server whose entry is in a file this program does not write keeps
 * the mode for this session only, and `done` says why.
 */
export function keepMcpTrustModeFromSettings(
  mcpRegistry: Pick<McpRegistry, 'setServerTrustMode' | 'storeServerPolicy' | 'listServerSecurity'>,
  serverName: string,
  mode: McpEntry['trustMode'],
  done: (message: string, entries: McpEntry[]) => void,
): void {
  try { mcpRegistry.setServerTrustMode(serverName, mode); }
  catch (error) {
    done(`${serverName} trust mode not changed: ${summarizeError(error)}`, buildMcpEntries(mcpRegistry));
    return;
  }
  done(`${serverName} trust mode is ${mode}; keeping it in its MCP config...`, buildMcpEntries(mcpRegistry));
  mcpRegistry.storeServerPolicy(serverName, { trustMode: mode }).then(
    (result) => done(`${serverName} trust mode is ${mode}, kept in ${result.scope} MCP config ${result.path}: it applies now and after a restart.`, buildMcpEntries(mcpRegistry)),
    (error: unknown) => done(`${serverName} trust mode is ${mode} for this session only: ${summarizeError(error)}`, buildMcpEntries(mcpRegistry)),
  );
}

import type { McpRegistry, McpToolRule } from '@goodvibes-jev/engine/platform/platform/mcp';
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

/** A per-tool rule typed on a server's row in Settings -> MCP. */
export interface McpToolRuleEdit {
  readonly rule: McpToolRule;
  readonly tool: string;
}

/** `allow <tool>`, `deny <tool>` or `clear <tool>`; null for anything else (a trust mode, a typo). */
export function parseMcpToolRuleEdit(text: string): McpToolRuleEdit | null {
  const match = /^(allow|deny|clear)\s+(\S+)$/i.exec(text.trim());
  if (!match) return null;
  return { rule: match[1]!.toLowerCase() as McpToolRule, tool: match[2]! };
}

/**
 * Keep one tool's rule from Settings -> MCP, the owner's own screen: the rule
 * is written with the server's entry in its MCP config file and applied at
 * once (an allow only in the owner's global file). `clear` removes whatever
 * rule is set for the tool, as /mcp clear does: the kept rule and this
 * session's denial. `done` gets the line to show and the refreshed rows once
 * the write and reload finish.
 */
export function keepMcpToolRuleFromSettings(
  mcpRegistry: Pick<McpRegistry, 'storeServerToolRule' | 'listServerSecurity' | 'clearServerToolDenial'>,
  serverName: string,
  edit: McpToolRuleEdit,
  done: (message: string, entries: McpEntry[]) => void,
): void {
  mcpRegistry.storeServerToolRule(serverName, edit.tool, edit.rule).then(
    (result) => {
      const where = `${result.scope} MCP config ${result.path}`;
      if (edit.rule === 'clear') {
        let sessionLifted = false;
        try { sessionLifted = mcpRegistry.clearServerToolDenial(serverName, edit.tool); }
        catch (error) {
          done(`${serverName} tool ${edit.tool}: ${result.changed ? `the kept rule is cleared in ${where}, but ` : ''}this session's denial was not lifted: ${summarizeError(error)}`, buildMcpEntries(mcpRegistry));
          return;
        }
        const removed = [...(result.changed ? [`the rule kept in ${where}`] : []), ...(sessionLifted ? ['the denial set for this session'] : [])];
        done(removed.length > 0
          ? `${serverName} tool ${edit.tool}: removed ${removed.join(' and ')}; its trust mode and scope decide each call again.`
          : `${serverName} tool ${edit.tool}: nothing changed; no rule was kept for it in ${where} and it was not denied for this session.`, buildMcpEntries(mcpRegistry));
        return;
      }
      const message = !result.changed
        ? `${serverName} tool ${edit.tool}: nothing changed; it was already ${edit.rule === 'allow' ? 'allowed' : 'denied'} in ${where}.`
        : edit.rule === 'deny'
          ? `${serverName} tool ${edit.tool} is denied, kept in ${where}: every call to it is refused, after a restart too.`
          : `${serverName} tool ${edit.tool} is allowed past the server's path and host scope, kept in ${where}. A blocked server, a quarantined schema or a denial still refuses it.`;
      done(message, buildMcpEntries(mcpRegistry));
    },
    (error: unknown) => done(`${serverName} tool ${edit.tool} not changed: ${summarizeError(error)}`, buildMcpEntries(mcpRegistry)),
  );
}

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

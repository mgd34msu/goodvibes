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
 * once (an allow only in the owner's global file). `done` gets the line to
 * show and the refreshed rows once the write and reload finish.
 */
export function keepMcpToolRuleFromSettings(
  mcpRegistry: Pick<McpRegistry, 'storeServerToolRule' | 'listServerSecurity'>,
  serverName: string,
  edit: McpToolRuleEdit,
  done: (message: string, entries: McpEntry[]) => void,
): void {
  mcpRegistry.storeServerToolRule(serverName, edit.tool, edit.rule).then(
    (result) => {
      const where = `${result.scope} MCP config ${result.path}`;
      const message = !result.changed
        ? `${serverName} tool ${edit.tool}: nothing changed; ${edit.rule === 'clear' ? 'no rule was kept for it' : `it was already ${edit.rule === 'allow' ? 'allowed' : 'denied'}`} in ${where}.`
        : edit.rule === 'deny'
          ? `${serverName} tool ${edit.tool} is denied, kept in ${where}: every call to it is refused, after a restart too.`
          : edit.rule === 'allow'
            ? `${serverName} tool ${edit.tool} is allowed past the server's path and host scope, kept in ${where}. A blocked server, a quarantined schema or a denial still refuses it.`
            : `${serverName} tool ${edit.tool}: the kept rule is cleared in ${where}; its trust mode and scope decide each call again.`;
      done(message, buildMcpEntries(mcpRegistry));
    },
    (error: unknown) => done(`${serverName} tool ${edit.tool} not changed: ${summarizeError(error)}`, buildMcpEntries(mcpRegistry)),
  );
}

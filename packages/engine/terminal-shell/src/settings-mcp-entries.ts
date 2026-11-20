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

/** A per-tool rule typed on a server's row in Settings -> MCP, in the words of /mcp. */
export interface McpToolRuleEdit {
  readonly rule: McpToolRule;
  readonly tool: string;
}

/** `block <tool>`, `unblock <tool>`, `exempt <tool>` or `unexempt <tool>`; null for anything else (a trust mode, a typo). */
export function parseMcpToolRuleEdit(text: string): McpToolRuleEdit | null {
  const match = /^(block|unblock|exempt|unexempt)\s+(\S+)$/i.exec(text.trim());
  if (!match) return null;
  return { rule: match[1]!.toLowerCase() as McpToolRule, tool: match[2]! };
}

/** The words a Settings -> MCP row takes besides a trust mode, for its hint and its refusal. */
export const MCP_TOOL_RULE_EDIT_WORDS = 'block <tool>, unblock <tool>, exempt <tool>, unexempt <tool>';

/**
 * Keep one tool's rule from Settings -> MCP, the owner's own screen, as the
 * /mcp action of the same word does with "until you change it": the rule is
 * written with the server's entry in its MCP config file and applied at once
 * (an exemption only in the owner's global file). `unblock` also ends this
 * session's block of the tool; `unexempt` drops only an exemption. `done`
 * gets the line to show and the refreshed rows once the write and reload finish.
 */
export function keepMcpToolRuleFromSettings(
  mcpRegistry: Pick<McpRegistry, 'storeServerToolRule' | 'listServerSecurity' | 'clearServerToolDenial'>,
  serverName: string,
  edit: McpToolRuleEdit,
  done: (message: string, entries: McpEntry[]) => void,
): void {
  const rules = mcpRegistry.listServerSecurity().find((server) => server.name === serverName)?.toolRules ?? [];
  const held = (rule: 'deny' | 'allow', source?: 'session' | 'stored') => rules.some((record) => record.toolName === edit.tool && record.rule === rule && (source === undefined || record.source === source));
  if (edit.rule === 'unblock' && !held('deny')) { done(`${edit.tool} on ${serverName} is not blocked; nothing changed.`, buildMcpEntries(mcpRegistry)); return; }
  if (edit.rule === 'unexempt' && !held('allow', 'stored')) { done(`${edit.tool} on ${serverName} does not go past its limits; nothing changed.`, buildMcpEntries(mcpRegistry)); return; }
  if (edit.rule === 'unblock' && !held('deny', 'stored')) {
    let lifted = false;
    try { lifted = mcpRegistry.clearServerToolDenial(serverName, edit.tool); } catch (error) { done(`${edit.tool} on ${serverName} not changed: ${summarizeError(error)}`, buildMcpEntries(mcpRegistry)); return; }
    done(lifted ? `Stopped blocking ${edit.tool} on ${serverName} (it was blocked for this session only).` : `${edit.tool} on ${serverName} is not blocked; nothing changed.`, buildMcpEntries(mcpRegistry));
    return;
  }
  mcpRegistry.storeServerToolRule(serverName, edit.tool, edit.rule).then(
    (result) => {
      const where = `${result.scope} MCP config ${result.path}`;
      let session = '';
      if (edit.rule === 'unblock') {
        try { if (mcpRegistry.clearServerToolDenial(serverName, edit.tool)) session = ' and this session\'s block'; }
        catch (error) { session = `; this session's block was not lifted: ${summarizeError(error)}`; }
      }
      const said = {
        block: `Blocked ${edit.tool} on ${serverName} until you change it, kept in ${where}.`,
        unblock: `Stopped blocking ${edit.tool} on ${serverName}: removed the block kept in ${where}${session}.`,
        exempt: `${edit.tool} on ${serverName} now goes past ${serverName}'s limits, until you change it, kept in ${where}.`,
        unexempt: `${edit.tool} on ${serverName} follows ${serverName}'s limits again (removed from ${where}).`,
      }[edit.rule];
      done(result.changed || session ? said : `Nothing changed: ${where} already held that for ${edit.tool}.`, buildMcpEntries(mcpRegistry));
    },
    (error: unknown) => done(`${edit.tool} on ${serverName} not changed: ${summarizeError(error)}`, buildMcpEntries(mcpRegistry)),
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

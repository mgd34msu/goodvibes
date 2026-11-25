import { MCP_TRUST_LEVEL_WORDS, mcpTrustWords } from '@goodvibes/engine/platform/platform/mcp/trust-words';
import type { HelpLine } from './settings-documentation.js';

type McpTrustModal = { readonly mcpAllowAllConfirmationTarget: string | null };
type McpTrustEntry = {
  readonly name: string;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly connected: boolean;
  readonly role: string;
  readonly trustMode: string;
  readonly toolRules?: readonly { readonly toolName: string; readonly rule: 'allow' | 'deny'; readonly source: 'session' | 'stored'; readonly inEffect: boolean }[] | undefined;
};

const text = (line: string): HelpLine => ({ kind: 'text', text: line });

/** The MCP trust help, each line with its kind: the allow-all confirmation is a warning by what it is, not by its wording. */
export function buildMcpHelp(modal: McpTrustModal, entry: McpTrustEntry | null): HelpLine[] {
  if (!entry) return [text('MCP trust'), text('No MCP server is selected.')];
  const scope = [
    entry.allowedPaths.length > 0 ? `Folders it may use: ${entry.allowedPaths.join(', ')}` : 'Folders it may use: any (none set, so folders are not checked)',
    entry.allowedHosts.length > 0 ? `Sites it may reach: ${entry.allowedHosts.join(', ')}` : 'Sites it may reach: any (none set, so addresses are not checked)',
  ].join('. ');
  const confirmation: HelpLine =
    modal.mcpAllowAllConfirmationTarget === entry.name
      ? { kind: 'warning', text: `Confirmation required: type ALLOW ALL ${entry.name} so it is no longer held to its folders and sites.` }
      : text('Enter edits the trust mode. Valid values are constrained, ask-on-risk, allow-all, and blocked.');
  const rules = entry.toolRules ?? [];
  return [
    text(entry.name),
    { kind: 'fact', text: `Connection: ${entry.connected ? 'connected' : 'disconnected'}` },
    { kind: 'fact', text: `Role: ${entry.role}` },
    { kind: 'fact', text: `Trust: it ${mcpTrustWords(entry.trustMode)}` },
    confirmation,
    text(''),
    text(scope),
    text(''),
    { kind: 'heading', text: 'Tool rules:' },
    ...(rules.length > 0
      ? rules.map((rule): HelpLine => ({ kind: 'text', text: `${rule.rule === 'deny' ? 'blocked' : 'past its limits'} ${rule.toolName}: ${rule.source === 'session' ? 'for this session only' : 'kept in the MCP config'}${rule.inEffect ? '' : '; a block wins'}` }))
      : [text('None. Every tool is decided by the trust mode and scope.')]),
    text('Enter, then type block, unblock, exempt or unexempt (a tool name after it is optional): Settings closes and that /mcp action opens for this server, asks what is missing and says what it will do. Block refuses every call to a tool; exempt lets it past the folder and site limits; unblock and unexempt end one of them.'),
    text(''),
    { kind: 'heading', text: 'Trust levels:' },
    ...MCP_TRUST_LEVEL_WORDS.map((level) => text(`${level.label}: ${level.help}`)),
  ];
}

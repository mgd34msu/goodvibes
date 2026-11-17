import type { HelpLine } from './settings-documentation.js';

type McpTrustModal = { readonly mcpAllowAllConfirmationTarget: string | null };
type McpTrustEntry = {
  readonly name: string;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly connected: boolean;
  readonly role: string;
  readonly trustMode: string;
};

const text = (line: string): HelpLine => ({ kind: 'text', text: line });

/** The MCP trust help, each line with its kind: the allow-all confirmation is a warning by what it is, not by its wording. */
export function buildMcpHelp(modal: McpTrustModal, entry: McpTrustEntry | null): HelpLine[] {
  if (!entry) return [text('MCP trust'), text('No MCP server is selected.')];
  const scope =
    entry.allowedPaths.length > 0
      ? `Allowed paths: ${entry.allowedPaths.join(', ')}`
      : entry.allowedHosts.length > 0
        ? `Allowed hosts: ${entry.allowedHosts.join(', ')}`
        : 'No explicit path or host scope is configured.';
  const confirmation: HelpLine =
    modal.mcpAllowAllConfirmationTarget === entry.name
      ? { kind: 'warning', text: `Confirmation required: type ALLOW ALL ${entry.name} to grant unrestricted trust.` }
      : text('Enter edits the trust mode. Valid values are constrained, ask-on-risk, allow-all, and blocked.');
  return [
    text(entry.name),
    { kind: 'fact', text: `Connection: ${entry.connected ? 'connected' : 'disconnected'}` },
    { kind: 'fact', text: `Role: ${entry.role}` },
    { kind: 'fact', text: `Trust mode: ${entry.trustMode}` },
    confirmation,
    text(''),
    text(scope),
    text(''),
    { kind: 'heading', text: 'Trust meanings:' },
    text('constrained: keep MCP activity inside declared paths/hosts and prompt on risk.'),
    text('ask-on-risk: allow routine MCP operations but ask before risky behavior.'),
    text('allow-all: allow unrestricted MCP operations for this server after explicit confirmation.'),
    text('blocked: prevent this MCP server from being used.'),
  ];
}

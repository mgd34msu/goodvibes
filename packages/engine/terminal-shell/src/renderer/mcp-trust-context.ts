export function buildMcpContext(
  modal: {
    readonly mcpAllowAllConfirmationTarget: string | null;
  },
  entry: {
    readonly name: string;
    readonly allowedPaths: readonly string[];
    readonly allowedHosts: readonly string[];
    readonly connected: boolean;
    readonly role: string;
    readonly trustMode: string;
  } | null,
): string[] {
  if (!entry) return ['MCP trust', 'No MCP server is selected.'];
  const scope =
    entry.allowedPaths.length > 0
      ? `Allowed paths: ${entry.allowedPaths.join(', ')}`
      : entry.allowedHosts.length > 0
        ? `Allowed hosts: ${entry.allowedHosts.join(', ')}`
        : 'No explicit path or host scope is configured.';
  const confirmation =
    modal.mcpAllowAllConfirmationTarget === entry.name
      ? `Confirmation required: type ALLOW ALL ${entry.name} to grant unrestricted trust.`
      : 'Enter edits the trust mode. Valid values are constrained, ask-on-risk, allow-all, and blocked.';
  return [
    entry.name,
    `Connection: ${entry.connected ? 'connected' : 'disconnected'}`,
    `Role: ${entry.role}`,
    `Trust mode: ${entry.trustMode}`,
    confirmation,
    '',
    scope,
    '',
    'Trust meanings:',
    'constrained: keep MCP activity inside declared paths/hosts and prompt on risk.',
    'ask-on-risk: allow routine MCP operations but ask before risky behavior.',
    'allow-all: allow unrestricted MCP operations for this server after explicit confirmation.',
    'blocked: prevent this MCP server from being used.',
  ];
}

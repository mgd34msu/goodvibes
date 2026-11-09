import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';
export function buildMcpEntries(mcpRegistry: Pick<McpRegistry, 'listServerSecurity'> | null): Array<Pick<ReturnType<McpRegistry['listServerSecurity']>[number], 'name' | 'connected' | 'role' | 'trustMode' | 'allowedPaths' | 'allowedHosts'>> {
  if (!mcpRegistry) return [];
  return mcpRegistry.listServerSecurity().map((entry) => ({
    name: entry.name,
    connected: entry.connected,
    role: entry.role,
    trustMode: entry.trustMode,
    allowedPaths: [...entry.allowedPaths],
    allowedHosts: [...entry.allowedHosts],
  }));
}

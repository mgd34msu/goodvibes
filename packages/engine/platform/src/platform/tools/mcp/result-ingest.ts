import type { ToolResult } from '../../types/tools.js';
import type { UntrustedIngest } from '../../security/untrusted-content.js';

/**
 * What an MCP tool call brought into the conversation, as untrusted content.
 *
 * A server's result text can be written by anyone the server reads from, so it
 * counts as exposure for the outward-effect check exactly as a fetched page
 * does. A result with no text is not recorded: nothing reached the model.
 * An error result is recorded too, because a server's error text is still
 * server-written text the model reads.
 */
export function mcpResultIngest(name: string, args: Record<string, unknown>, result: Pick<ToolResult, 'output'>): UntrustedIngest | undefined {
  if (name !== 'mcp' || args.mode !== 'call') return undefined;
  const content = result.output;
  if (typeof content !== 'string' || content.trim().length === 0) return undefined;
  const qualifiedName = typeof args.qualifiedName === 'string' ? args.qualifiedName : '';
  return { surface: 'document', origin: qualifiedName || 'an MCP tool', at: new Date().toISOString(), content };
}

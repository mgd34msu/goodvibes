import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool, ToolDefinition } from '@goodvibes-jev/engine/platform/platform/types';

/**
 * A minimal stand-in for the platform tool registry.
 *
 * Unit tests for Agent-owned tools only need register/has/list/getToolDefinitions.
 * Using a double instead of constructing the real registry keeps these tests
 * from loading the platform's runtime barrel, so a tool's own behavior is verified
 * even when an unrelated part of the platform cannot be imported.
 */
export class ToolRegistryDouble {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.list().map((tool) => tool.definition);
  }
}

/** The double typed as the registry the production code expects. */
export function createToolRegistryDouble(): ToolRegistry {
  return new ToolRegistryDouble() as unknown as ToolRegistry;
}

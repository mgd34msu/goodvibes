/**
 * The tools the model can call in this program, as the tool capabilities
 * (platform capabilities/builtin/tools.ts) take them: this program's tool
 * registry, its contract checks in the verifier's own words, and the live list
 * a form chooses a tool from. Both terminal programs build the same services
 * from their registry (session-capabilities.ts in each).
 */
import { TOOLS_LIST, type ToolContractCheck, type ToolRegistryCapabilityServices } from '@goodvibes/engine/platform/platform/capabilities';
import { ToolContractVerifier } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { defineList, type ListRow } from './command-actions/lists.js';

type Registry = Pick<ToolRegistry, 'list' | 'verifyContract' | 'verifyAllContracts'>;

const descriptionOf = (value: unknown): string => typeof value === 'string' ? value : '';

/** This program's tool registry as the tool capabilities read it. */
export function toolRegistryServices(registry: Registry | undefined): ToolRegistryCapabilityServices['toolRegistry'] {
  const tools = (): ReturnType<Registry['list']> => registry?.list() ?? [];
  return {
    list: () => tools().map((tool) => ({ name: tool.definition.name, description: descriptionOf(tool.definition.description) })),
    describe(name) {
      const tool = tools().find((entry) => entry.definition.name === name);
      return tool ? { name: tool.definition.name, description: descriptionOf(tool.definition.description), parameters: tool.definition.parameters } : undefined;
    },
    async verify(name): Promise<ToolContractCheck | undefined> {
      const result = await registry?.verifyContract(name);
      return result ? { tool: result.toolName, passed: result.passed, text: ToolContractVerifier.formatResult(result) } : undefined;
    },
    async verifyAll() {
      const results = registry ? await registry.verifyAllContracts() : new Map();
      return {
        checks: [...results.values()].map((result) => ({ tool: result.toolName, passed: result.passed, text: ToolContractVerifier.formatResult(result) })),
        text: ToolContractVerifier.formatAllResults(results),
      };
    },
  };
}

/** The tools the model can call here, for a form that asks for one. */
defineList<{ readonly extensions?: { readonly toolRegistry?: Registry | undefined } | undefined }>({
  name: TOOLS_LIST,
  async read(ctx) {
    return toolRegistryServices(ctx.extensions?.toolRegistry).list().map((tool): ListRow => ({ value: tool.name, label: tool.name, detail: tool.description.slice(0, 80) }));
  },
  operator: { terminalOnly: 'The tools are the terminal program\'s own.' },
});

/**
 * The Tools and extensions place's list of this program's tools (a session source: the web UI has none), read from
 * the tool services this program's session capabilities already built (`toolRegistryServices` above).
 */
export function toolsPlaceSource(tools: () => ToolRegistryCapabilityServices['toolRegistry'] | undefined): { read(): unknown; subscribe(onChange: () => void): () => void } {
  return {
    read: () => tools()?.list() ?? [],
    // The registry changes when a plugin or a tool server comes or goes; the place reads it again on its own reads.
    subscribe: () => () => {},
  };
}

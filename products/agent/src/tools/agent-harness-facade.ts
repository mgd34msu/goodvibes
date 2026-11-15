import type { Tool, ToolDefinition } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolExecuteOptions, ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { createHarnessCatalogInputProjector, forwardHarnessCatalogCall, isHarnessCatalogQuery, protectHarnessCatalogTool } from './agent-harness-catalog-ingress.ts';

export interface HarnessFacadeDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  /** A specific harness instance; otherwise the registered `agent_harness` is used. */
  readonly harnessTool?: Tool;
}

type FacadeResult = Awaited<ReturnType<Tool['execute']>>;

export interface HarnessFacadeCall<A> {
  /** The call's arguments, read once through the model-reading capture. */
  readonly args: A;
  readonly rawArgs: Record<string, unknown>;
  readonly options: ToolExecuteOptions | undefined;
  /** Forward a translated harness call under the original call's admission. */
  forward(translated: Record<string, unknown>, additionalGuard?: () => void): Promise<FacadeResult>;
}

export interface HarnessFacadeSpec<A> {
  readonly definition: ToolDefinition;
  /** Which inputs carry free text the catalog ingress screens; defaults to the shared catalog rule. */
  readonly selected?: (input: Record<string, unknown>) => boolean;
  route(call: HarnessFacadeCall<A>): Promise<FacadeResult> | FacadeResult;
}

/**
 * The harness every facade forwards to: the one registered as `agent_harness`,
 * so a wrapper attached at registration covers facade calls too. A registry
 * without one (an embedder or a test) gets one built on first use.
 */
export function facadeHarness(deps: HarnessFacadeDeps): () => Tool {
  let built: Tool | undefined;
  return () => deps.harnessTool
    ?? deps.toolRegistry.list().find((tool) => tool.definition.name === 'agent_harness')
    ?? (built ??= createAgentHarnessTool({ commandRegistry: deps.commandRegistry, commandContext: deps.commandContext, toolRegistry: deps.toolRegistry }));
}

/**
 * One facade over the harness: the facade translates its action into a harness
 * mode, and this owns the ingress (argument capture, catalog screening, and the
 * forwarded admission) the same way for every facade.
 */
export function createHarnessFacade<A extends object>(deps: HarnessFacadeDeps, spec: HarnessFacadeSpec<A>): Tool {
  const harness = facadeHarness(deps);
  const selected = spec.selected ?? isHarnessCatalogQuery;
  const tool: Tool = {
    definition: spec.definition,
    execute: async (rawArgs, options) => {
      const args = captureModelReadingInput(rawArgs) as A;
      return spec.route({ args, rawArgs, options,
        forward: (translated, additionalGuard) => forwardHarnessCatalogCall(harness(), rawArgs, translated, options, additionalGuard) });
    },
  };
  return protectHarnessCatalogTool(tool, deps.toolRegistry, selected, deps.commandContext);
}

/** Register a facade with the same catalog input projection its execute path applies. */
export function registerHarnessFacade(registry: ToolRegistry, tool: Tool, context: CommandContext,
  selected: (input: Record<string, unknown>) => boolean = isHarnessCatalogQuery): void {
  if (registry.has(tool.definition.name)) return;
  registry.register(tool, { inputProjection: createHarnessCatalogInputProjector(registry, undefined, selected, context) });
}

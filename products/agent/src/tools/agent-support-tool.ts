import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';

type AgentSupportAction = 'status' | 'bundle';

interface AgentSupportToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly bundlePath?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type AgentSupportToolDeps = HarnessFacadeDeps;

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSupportAction(value: unknown): AgentSupportAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (['status', 'summary', 'list', 'catalog', 'routes', 'bundles', 'diagnostics'].includes(action)) return 'status';
  if (['bundle', 'inspect', 'show', 'get', 'support_bundle'].includes(action)) return 'bundle';
  return null;
}

function readAction(args: AgentSupportToolArgs): AgentSupportAction | null {
  // A word that was sent but is not an action is refused (null), not replaced by an inferred one.
  if (readString(args.action) || readString(args.mode)) return normalizeSupportAction(args.action) ?? normalizeSupportAction(args.mode);
  if (readString(args.bundlePath) || readString(args.id)) return 'bundle';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function statusArgs(args: AgentSupportToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'support_bundles',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function bundleArgs(args: AgentSupportToolArgs): Record<string, unknown> {
  const bundlePath = readString(args.bundlePath) || readString(args.id);
  return compactArgs({
    mode: 'support_bundle',
    bundlePath,
    target: bundlePath ? undefined : args.target,
    query: bundlePath ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentSupportTool(deps: AgentSupportToolDeps): Tool {
  return createHarnessFacade<AgentSupportToolArgs>(deps, {
    definition: {
      name: 'support',
      description: 'Read support-bundle routes and redacted bundle summaries.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'bundle'],
            description: 'List support bundle routes or inspect one existing bundle.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Alias for bundlePath.' },
          bundlePath: { type: 'string', description: 'Workspace-relative support bundle path to inspect.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed route and policy metadata.' },
          limit: { type: 'number', description: 'Maximum bundle routes returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    route({ args, forward }) {
      const action = readAction(args);
      if (!action) return error('Unknown support action. Use one of: status, bundle.');
      if (action === 'status') return forward(statusArgs(args));
      if (action === 'bundle') return forward(bundleArgs(args));
      return error('Unknown support action. Use one of: status, bundle.');
    },
  });
}

export function registerAgentSupportTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  registerHarnessFacade(registry, createAgentSupportTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext);
}

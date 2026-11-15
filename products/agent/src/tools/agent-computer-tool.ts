import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';

type AgentComputerAction =
  | 'status'
  | 'plan'
  | 'control'
  | 'browser'
  | 'open_browser'
  | 'setup'
  | 'mcp';

interface AgentComputerToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

type AgentComputerToolDeps = HarnessFacadeDeps;

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeComputerAction(value: unknown): AgentComputerAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'overview' || action === 'computer' || action === 'computer_use') return 'status';
  if (action === 'plan' || action === 'route' || action === 'control_plan' || action === 'browser_plan' || action === 'desktop_plan' || action === 'screenshot' || action === 'screen' || action === 'screen_recording' || action === 'observe') return 'plan';
  if (action === 'control' || action === 'browser_control' || action === 'desktop' || action === 'desktop_control') return 'control';
  if (action === 'browser' || action === 'pwa' || action === 'cockpit' || action === 'browser_cockpit' || action === 'web') return 'browser';
  if (action === 'open' || action === 'open_browser' || action === 'open_pwa' || action === 'open_cockpit' || action === 'open_browser_cockpit') return 'open_browser';
  if (action === 'setup' || action === 'configure' || action === 'browser_desktop_control') return 'setup';
  if (action === 'mcp' || action === 'tools' || action === 'servers' || action === 'mcp_servers') return 'mcp';
  return null;
}

function readAction(args: AgentComputerToolArgs): AgentComputerAction | null {
  const explicit = readString(args.action) || readString(args.mode);
  return explicit ? normalizeComputerAction(explicit) : 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function controlArgs(args: AgentComputerToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'execution_route',
    executionRouteId: 'browser-or-desktop-control',
    includeParameters: args.includeParameters ?? true,
  });
}

function planArgs(args: AgentComputerToolArgs): Record<string, unknown> {
  const rawAction = readString(args.action) || readString(args.mode);
  const normalizedAction = rawAction.toLowerCase().replace(/-/g, '_');
  const actionAsQuery = ['screenshot', 'screen', 'screen_recording', 'observe'].includes(normalizedAction) ? rawAction : undefined;
  return compactArgs({
    mode: 'browser_control_route',
    query: args.query ?? args.target ?? actionAsQuery,
    includeParameters: args.includeParameters,
  });
}

function browserArgs(args: AgentComputerToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'ui_surface',
    surfaceId: 'connected-browser-cockpit',
    includeParameters: args.includeParameters ?? true,
  });
}

function openBrowserArgs(args: AgentComputerToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'open_ui_surface',
    surfaceId: 'connected-browser-cockpit',
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

function setupArgs(args: AgentComputerToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'setup_item',
    setupItemId: 'browser-desktop-control',
    includeParameters: args.includeParameters ?? true,
  });
}

function mcpArgs(args: AgentComputerToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'mcp_servers',
    query: args.query ?? args.target ?? 'browser desktop',
    includeParameters: args.includeParameters,
  });
}

export function createAgentComputerTool(deps: AgentComputerToolDeps): Tool {
  return createHarnessFacade<AgentComputerToolArgs>(deps, {
    definition: {
      name: 'computer',
      description: 'Inspect/open browser, desktop, and computer-use routes.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'plan', 'control', 'browser', 'open_browser', 'setup', 'mcp'],
            description: 'Computer, browser/PWA, setup, MCP, or open route. Opening a visible surface needs the owner\'s current recorded effect admission.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          target: { type: 'string', description: 'Lookup or search target.' },
          query: { type: 'string', description: 'Search text for action:"mcp". When omitted the search is for "browser desktop", so the list is filtered, not complete; pass a broader query to see more.' },
          includeParameters: { type: 'boolean', description: 'Include detailed route contracts.' },
          confirm: { type: 'boolean', description: 'Optional provenance; does not grant authority. Opening is allowed only under the owner\'s recorded effect admission.' },
          explicitUserRequest: { type: 'string', description: 'Optional request provenance; does not grant authority.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    selected: isComputerWorkflowQuery,
    route({ args, forward }) {
      const action = readAction(args);
      if (action === 'status' || action === 'control') return forward(controlArgs(args));
      if (action === 'plan') return forward(planArgs(args));
      if (action === 'browser') return forward(browserArgs(args));
      if (action === 'open_browser') return forward(openBrowserArgs(args));
      if (action === 'setup') return forward(setupArgs(args));
      if (action === 'mcp') return forward(mcpArgs(args));
      return error('Unknown computer action. Use action (or mode) as one of: status, plan, control, browser, open_browser, setup, mcp.');
    },
  });
}

export function isComputerWorkflowQuery(input: Record<string, unknown>): boolean {
  return readAction(captureModelReadingInput(input)) === 'plan';
}

export function registerAgentComputerTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  registerHarnessFacade(registry, createAgentComputerTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext, isComputerWorkflowQuery);
}

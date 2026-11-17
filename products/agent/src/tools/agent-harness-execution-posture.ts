import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import type { CommandContext } from '../input/command-registry.ts';
import { captureBrowserControlPosture, type BrowserControlPosture } from './agent-harness-browser-control.ts';
import { delegationDecisionCards } from './agent-harness-delegation-posture.ts';
import { fileRecoveryCatalogStatus } from './agent-harness-file-recovery.ts';
import { sudoExecutionPosture } from './agent-harness-sudo-posture.ts';
import { previewHarnessText } from '@goodvibes-jev/engine/terminal-shell/agent-turn/preview-text';
import { clampReadLimit } from '@goodvibes-jev/engine/terminal-shell/agent-turn/read-helpers';

export interface AgentHarnessExecutionArgs {
  readonly executionRouteId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type ExecutionResolution =
  | { readonly status: 'found'; readonly route: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type ExecutionLookupSource = 'executionRouteId' | 'target' | 'query';
type ExecutionEffect = 'read-only' | 'local-effect' | 'external-read' | 'delegated-work' | 'ui-control';
type ExecutionAvailability = 'ready' | 'setup-needed' | 'fallback-only';

interface ExecutionSupervisionRoute {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly modelRoute: string;
  readonly requiresConfirmation?: boolean;
}

interface ExecutionRoute {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly userOutcome: string;
  readonly effect: ExecutionEffect;
  readonly preferredWhen: string;
  readonly useInsteadWhen?: string;
  readonly toolNames?: readonly string[];
  readonly anyToolNames?: readonly string[];
  readonly browserMcp?: boolean;
  readonly modelRoute: string;
  readonly recoveryRoute?: string;
  readonly safety: string;
  readonly nextStep: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function lookupFromArgs(args: AgentHarnessExecutionArgs): { readonly source: ExecutionLookupSource; readonly input: string } | null {
  const executionRouteId = readString(args.executionRouteId);
  if (executionRouteId) return { source: 'executionRouteId', input: executionRouteId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function routeDefinitions(): readonly ExecutionRoute[] {
  return [
    {
      id: 'local-read-search-analyze',
      label: 'Local read, search, and analysis',
      detail: 'Use workspace read/search/inspect/analyze tools to understand files, diffs, logs, and project structure before taking action.',
      userOutcome: 'The user gets direct answers from the current workspace without delegation ceremony.',
      effect: 'read-only',
      preferredWhen: 'The task needs project context, code review, log triage, or file inspection and the current workspace is the target.',
      useInsteadWhen: 'Use delegation only when the user needs a remote workspace, parallel review, or isolated runner.',
      anyToolNames: ['read', 'find', 'inspect', 'analyze'],
      modelRoute: 'read/find/inspect/analyze',
      safety: 'Read-only tools must stay bounded to the current permitted workspace and avoid raw secret disclosure.',
      nextStep: 'Call the narrowest read/search/analyze tool that answers the user request.',
    },
    {
      id: 'local-edit-write',
      label: 'Local file edit and write',
      detail: 'Use local edit/write tools for explicit implementation, fix, patch, or document changes when this Agent workspace is the intended target.',
      userOutcome: 'The user gets the requested change in place without a handoff when local permissions are already sufficient.',
      effect: 'local-effect',
      preferredWhen: 'The user asks to implement, fix, patch, refactor, update docs, or edit files in the current workspace.',
      useInsteadWhen: 'Use delegation for isolated worktrees, remote machines, parallel workers, or work that needs a separate coding UI.',
      anyToolNames: ['edit', 'write'],
      modelRoute: 'edit/write',
      recoveryRoute: 'execution action:"recovery"',
      safety: 'Respect user-owned dirty worktree changes, keep edits scoped, and verify with tests or static checks when feasible.',
      nextStep: 'Use local edit/write tooling, then run targeted verification through the local shell route when appropriate.',
    },
    {
      id: 'local-shell-command',
      label: 'Local shell command',
      detail: 'Run bounded foreground shell commands for discovery, builds, tests, formatting, verification, and explicit user-supervised sudo when the user request and workspace allow it.',
      userOutcome: 'The user sees progress and results from the actual environment without extra routing decisions.',
      effect: 'local-effect',
      preferredWhen: 'The task needs command output, project tests, build checks, package inspection, safe one-off automation, or visible privilege escalation in the current workspace.',
      useInsteadWhen: 'Use execution action:"processes" plus terminal/process for user-approved long-running local commands; use delegation or connected-host tasks for isolation, remote execution, or parallelism.',
      toolNames: ['exec'],
      modelRoute: 'exec',
      safety: 'Use foreground serial commands, avoid destructive operations unless explicitly requested, keep sudo visible and user-supervised, block hidden background sudo prompts, and report verification results clearly.',
      nextStep: 'Call exec for bounded foreground commands, inspect setup_item sudo-execution-posture before escalation, or inspect execution action:"processes" before starting tracked long-running local work.',
    },
    {
      id: 'web-fetch-research',
      label: 'Web and URL evidence',
      detail: 'Use registered web_search or fetch tools for current public information, source inspection, and evidence gathering.',
      userOutcome: 'The user gets sourced current information without pretending local knowledge is fresh.',
      effect: 'external-read',
      preferredWhen: 'The request depends on current, public, or third-party information.',
      useInsteadWhen: 'Use research run/source/report tools when the answer needs a durable research ledger or citation repair.',
      anyToolNames: ['web_search', 'fetch'],
      modelRoute: 'web_search/fetch',
      safety: 'Read-only browsing must use relevant sources, attribution, and source limits; authenticated or mutating web actions need explicit tools.',
      nextStep: 'Call web_search or fetch, then capture durable sources when a longer research workflow is useful.',
    },
    {
      id: 'browser-or-desktop-control',
      label: 'Browser or desktop control',
      detail: 'Use browser, desktop, or computer-control MCP/tooling only when a trusted server or first-class tool is configured.',
      userOutcome: 'The user can automate real UI flows when setup is present, and gets a clear setup gap when it is not.',
      effect: 'ui-control',
      preferredWhen: 'The user asks for browser navigation, UI testing, screenshots, screen recording, or device/desktop actions.',
      useInsteadWhen: 'Use read-only web tools for research that does not require controlling a live browser or desktop.',
      browserMcp: true,
      modelRoute: 'mcp/browser tools',
      safety: 'Browser and desktop control must use trusted servers, constrained paths/hosts, and visible confirmation for external effects.',
      nextStep: 'Inspect MCP/browser setup, then use the configured browser tool or report the setup blocker.',
    },
    {
      id: 'delegation-isolation-parallel-remote',
      label: 'Delegation, isolation, parallelism, or remote work',
      detail: 'Use GoodVibes TUI/shared-session delegation when the user benefits from isolation, remote execution, separate worktrees, parallel workers, or delegated review.',
      userOutcome: 'The user gets heavier execution routed to the right supervised environment without blocking ordinary local work.',
      effect: 'delegated-work',
      preferredWhen: 'The task needs a remote host, isolated worktree, parallel agent, separate coding UI, or user-requested delegated review.',
      useInsteadWhen: 'Use local read/edit/exec when the current workspace and permissions are sufficient for a normal implementation or verification task.',
      modelRoute: 'delegation action:"status"',
      safety: 'Delegated work submission must preserve the full original ask and remain visible and confirmation-gated.',
      nextStep: 'Inspect delegation action:"status" or action:"route" before submitting a confirmed handoff.',
    },
  ];
}

/** The facts every route row is built from, read once per call. */
interface ExecutionFacts {
  readonly toolNames: ReadonlySet<string>;
  readonly browserControl: BrowserControlPosture;
  /** The delegation posture's own answer: an operator client is attached for a TUI handoff. */
  readonly delegationReady: boolean;
}

function readExecutionFacts(context: CommandContext, toolRegistry: ToolRegistry, browserControl: BrowserControlPosture): ExecutionFacts {
  let names: ReadonlySet<string>;
  try {
    names = new Set(toolRegistry.getToolDefinitions().map((tool) => tool.name));
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
  const handoff = delegationDecisionCards(context).find((card) => card.id === 'delegate-decision-tui-handoff');
  return { toolNames: names, browserControl, delegationReady: handoff?.status === 'ready' };
}

function routeAvailability(route: ExecutionRoute, facts: ExecutionFacts): ExecutionAvailability {
  if (route.id === 'delegation-isolation-parallel-remote') return facts.delegationReady ? 'ready' : 'setup-needed';
  if (route.browserMcp) return facts.browserControl.configured ? 'ready' : 'setup-needed';
  if (route.toolNames?.every((name) => facts.toolNames.has(name))) return 'ready';
  if (route.anyToolNames?.some((name) => facts.toolNames.has(name))) return 'ready';
  return route.effect === 'read-only' ? 'fallback-only' : 'setup-needed';
}

function availableTools(route: ExecutionRoute, facts: ExecutionFacts): readonly string[] {
  return [...(route.toolNames ?? []), ...(route.anyToolNames ?? [])].filter((name) => facts.toolNames.has(name));
}

function routeSearchText(route: ExecutionRoute): string {
  return [
    route.id,
    route.label,
    route.detail,
    route.userOutcome,
    route.effect,
    route.preferredWhen,
    route.useInsteadWhen ?? '',
    route.modelRoute,
    route.recoveryRoute ?? '',
    route.nextStep,
    ...(route.toolNames ?? []),
    ...(route.anyToolNames ?? []),
  ].join('\n');
}

function describeCandidate(route: ExecutionRoute, facts: ExecutionFacts): Record<string, unknown> {
  return {
    executionRouteId: route.id,
    label: route.label,
    effect: route.effect,
    availability: routeAvailability(route, facts),
    modelRoute: route.modelRoute,
  };
}

function executionSupervisionRoutes(context: CommandContext, route: ExecutionRoute): readonly ExecutionSupervisionRoute[] {
  const routes: ExecutionSupervisionRoute[] = [];
  if (route.id === 'local-shell-command') {
    routes.push(
      {
        id: 'process-monitor',
        label: 'Runtime Activity Monitor',
        available: typeof context.openProcessModal === 'function',
        modelRoute: 'workspace action:"open" surfaceId:"process-monitor"',
        requiresConfirmation: true,
      },
      {
        id: 'live-tail',
        label: 'Live Process Output',
        available: typeof context.openLiveTail === 'function',
        modelRoute: 'workspace action:"open" surfaceId:"live-tail"',
        requiresConfirmation: true,
      },
    );
  }
  return routes;
}

function executionSupervisionSummary(context: CommandContext): Record<string, unknown> {
  return {
    processMonitorAvailable: typeof context.openProcessModal === 'function',
    liveTailAvailable: typeof context.openLiveTail === 'function',
    routes: [
      'workspace action:"open" surfaceId:"process-monitor"',
      'workspace action:"open" surfaceId:"live-tail"',
    ],
  };
}

function describeRoute(
  route: ExecutionRoute,
  context: CommandContext,
  facts: ExecutionFacts,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const availability = routeAvailability(route, facts);
  const tools = availableTools(route, facts);
  const supervisionRoutes = executionSupervisionRoutes(context, route);
  const browserControl = route.browserMcp ? facts.browserControl : null;
  const delegationCards = route.id === 'delegation-isolation-parallel-remote' && options.includeParameters ? delegationDecisionCards(context) : null;
  return {
    executionRouteId: route.id,
    label: route.label,
    effect: route.effect,
    availability,
    ...(tools.length > 0 ? { availableTools: tools } : {}),
    ...(supervisionRoutes.length > 0 ? { supervisionRoutes } : {}),
    modelRoute: route.modelRoute,
    ...(route.recoveryRoute ? { recoveryRoute: route.recoveryRoute } : {}),
    preferredWhen: options.includeParameters ? route.preferredWhen : previewHarnessText(route.preferredWhen),
    nextStep: options.includeParameters ? route.nextStep : previewHarnessText(route.nextStep),
    ...(options.includeParameters
      ? {
        detail: route.detail,
        userOutcome: route.userOutcome,
        useInsteadWhen: route.useInsteadWhen ?? null,
        safety: route.safety,
        toolNames: route.toolNames ?? [],
        anyToolNames: route.anyToolNames ?? [],
        browserMcp: route.browserMcp === true,
        ...(browserControl ? { browserControl } : {}),
        ...(delegationCards ? { delegationDecisionCards: delegationCards } : {}),
        modelAccess: {
          inspectPosture: 'execution action:"status"',
          inspectRoute: `execution action:"route" id:"${route.id}"`,
          inspectTools: 'agent_harness mode:"tools"',
          inspectDelegation: 'delegation action:"status"',
          inspectFileRecovery: route.recoveryRoute ?? 'execution action:"recovery"',
        },
      }
      : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };
}

async function matchingRoutes(routes: readonly ExecutionRoute[], input: string, options: CatalogRankingOptions) {
  if (!input) return { matches: routes.map(entry => ({ entry, judgment: undefined })), judgments: [] };
  return rankHarnessCatalog(routes, input, route => ({ id: route.id, description: routeSearchText(route) }), 'agent.harness.execution-posture', options);
}

export async function executionPostureCatalogStatus(context: CommandContext, toolRegistry: ToolRegistry, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const { posture } = await captureBrowserControlPosture(context, toolRegistry, options);
  const facts = readExecutionFacts(context, toolRegistry, posture);
  const routes = routeDefinitions();
  const statuses = routes.map((route) => routeAvailability(route, facts));
  return {
    modes: ['execution_posture', 'execution_route', 'browser_control_route'],
    routes: routes.length,
    readyRoutes: statuses.filter((status) => status === 'ready').length,
    setupNeededRoutes: statuses.filter((status) => status === 'setup-needed').length,
    readOnly: true,
  };
}

export async function executionPostureSummary(context: CommandContext, toolRegistry: ToolRegistry, args: AgentHarnessExecutionArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const query = readString(args.query);
  const includeParameters = args.includeParameters === true;
  // One look at the tools, the browser posture and the delegation posture; every row is built from it.
  const { posture: browserControl } = await captureBrowserControlPosture(context, toolRegistry, options);
  const facts = readExecutionFacts(context, toolRegistry, browserControl);
  const definitions = routeDefinitions();
  const selected = await matchingRoutes(definitions, query, options);
  options.signal?.throwIfAborted();
  const routes = selected.matches.slice(0, readLimit(args.limit, 100));
  const delegationCards = delegationDecisionCards(context);
  return {
    status: 'available',
    summary: {
      localFirstPolicy: 'Use local read/edit/exec when the current workspace and permissions are sufficient.',
      delegationPolicy: 'Use delegation for isolation, parallelism, remote execution, separate worktrees, or user-requested delegated review.',
      browserControl: browserControl.status,
      browserControlSetup: browserControl,
      delegationDecisionCards: delegationCards,
      sudoPosture: sudoExecutionPosture(context),
      interactiveRuntime: browserControl.runtime,
      executionHistory: 'execution action:"history"',
      backgroundProcesses: 'execution action:"processes"',
      fileRecovery: fileRecoveryCatalogStatus(context),
      supervision: executionSupervisionSummary(context),
      registeredExecutionTools: ['read', 'find', 'inspect', 'analyze', 'edit', 'write', 'exec', 'fetch', 'web_search'].filter((name) => facts.toolNames.has(name)).sort(),
    },
    decisionRules: [
      'Do not delegate ordinary local implementation, fix, review, or verification work when local tools and permissions are sufficient.',
      'Do delegate when isolation, parallelism, remote execution, a separate worktree, or a requested delegated review improves the user outcome.',
      'Report setup gaps directly for browser/desktop control instead of pretending browser automation exists.',
      'interactiveRuntime says what runs now: tracked processes and their output come from the process manager, sudo is foreground-only, no PTY session owner exists, and browser/desktop control is ready only when a route in browserControlSetup can be invoked.',
      'Use tracked background processes for approved long-running local commands instead of hidden exec background mode.',
    ],
    routes: routes.map(({ entry, judgment }) => ({ ...describeRoute(entry, context, facts, { includeParameters }), ...(judgment ? { judgment } : {}) })),
    judgments: selected.judgments,
    returned: routes.length,
    total: definitions.length,
    policy: 'Read-only execution posture. It selects routes and safety boundaries; actual tool calls remain governed by each first-class tool policy.',
  };
}

export async function describeHarnessExecutionRoute(context: CommandContext, toolRegistry: ToolRegistry, args: AgentHarnessExecutionArgs, options: CatalogRankingOptions = {}): Promise<ExecutionResolution> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'execution action:"route" requires executionRouteId, target, or query. Use execution action:"status" to inspect execution route ids.',
    };
  }
  // An exact id is a lookup in the constant table; the facts are read only for the row returned.
  const all = routeDefinitions();
  const normalized = lookup.input.toLowerCase();
  const exact = all.find((route) => route.id === lookup.input);
  const insensitive = exact ? undefined : all.find((route) => route.id.toLowerCase() === normalized);
  const found = exact ?? insensitive;
  const facts = async () => readExecutionFacts(context, toolRegistry, (await captureBrowserControlPosture(context, toolRegistry, options)).posture);
  if (found) {
    return { status: 'found', route: describeRoute(found, context, await facts(), { includeParameters: true,
      lookup: { ...lookup, resolvedBy: exact ? 'id' : 'case-insensitive-id' } }) };
  }
  const selected = lookup.source === 'executionRouteId' ? { matches: [], judgments: [] }
    : await matchingRoutes(all, lookup.input, options);
  options.signal?.throwIfAborted();
  const searched = selected.matches;
  if (searched.length === 0) {
    return {
      status: 'missing_lookup',
      usage: `Unknown execution route ${lookup.input}. Use execution action:"status" to list route ids.`,
    };
  }
  const read = await facts();
  if (searched.length === 1 && searched[0]!.judgment?.reading.verdict === 'yes' && searched[0]!.judgment?.reading.outcome === 'act') {
    return { status: 'found', route: { ...describeRoute(searched[0]!.entry, context, read, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }), judgment: searched[0]!.judgment } };
  }
  return {
    status: 'ambiguous',
    input: lookup.input,
    candidates: searched.slice(0, 8).map(({ entry, judgment }) => ({ ...describeCandidate(entry, read), judgment })),
  };
}

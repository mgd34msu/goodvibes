import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { readInteractiveRuntime, type InteractiveRuntimeSnapshot } from './agent-harness-interactive-runtime-records.ts';
import { isAgentMcpCallRouteInstalled } from './agent-mcp-call-route.ts';
import type { ToolCapability, ToolDefinition } from '@goodvibes-jev/engine/platform/platform/types';
import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';

type BrowserControlStatus = 'ready' | 'attention' | 'setup-needed';
/** A capability row: `unavailable` when no registered tool declares it, whatever else is configured. */
type BrowserControlCapabilityStatus = BrowserControlStatus | 'unavailable';
type BrowserControlDecisionStatus = 'ready-to-inspect-tool' | 'review-connector-first' | 'setup-needed';

export interface BrowserControlRouteArgs {
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

interface BrowserControlMcpServer {
  readonly name: string;
  readonly connected: boolean;
  readonly role: string;
  readonly trustMode: string;
  readonly schemaFreshness: string;
  readonly readiness: 'ready' | 'attention';
  readonly modelRoute: string;
}

interface BrowserControlWorkflow {
  readonly id: string;
  readonly label: string;
  readonly status: BrowserControlCapabilityStatus;
  readonly summary: string;
  readonly next: string;
  readonly inspectRoute: string;
  readonly setupRoute: string;
  readonly safety: string;
}

interface BrowserControlDecision {
  readonly id: string;
  readonly status: BrowserControlDecisionStatus;
  readonly modelRoute: string;
  readonly userRoute: string;
  readonly nextStep: string;
  readonly reason: string;
  readonly safety: string;
}

/**
 * A route that can actually be called right now.
 *
 * Readiness is computed from this list and nothing else. A capability that
 * reports "ready" while every named route is uninvocable is the exact failure
 * this file used to have: it advertised availability:"ready" and pointed the
 * model at MCP browser tools that no tool mode could invoke, and the model
 * spent a session improvising around a route that did not exist.
 */
export interface BrowserControlInvocationRoute {
  readonly kind: 'first-class-tool' | 'mcp-tool-call';
  readonly toolName: string;
  readonly modelRoute: string;
  readonly summary: string;
}

export interface BrowserControlPosture {
  readonly status: BrowserControlStatus;
  readonly configured: boolean;
  readonly needsReview: boolean;
  /** Every route that can be invoked as-is. Empty means nothing can drive a browser. */
  readonly invocationRoutes: readonly BrowserControlInvocationRoute[];
  /** Named blockers when nothing is invocable, each with the fix. */
  readonly blockers: readonly string[];
  /** Registered tools that DECLARED browser control. Never inferred from text. */
  readonly declaredControlTools: readonly string[];
  /** Same list as declaredControlTools, kept for existing readers of this posture. */
  readonly toolMatches: readonly string[];
  readonly mcpServers: readonly BrowserControlMcpServer[];
  readonly runtime: Record<string, unknown>;
  readonly workflows: readonly BrowserControlWorkflow[];
  readonly setupChecklist: readonly string[];
  readonly fallbackRoutes: readonly string[];
  readonly executionRoute: string;
  readonly setupRoute: string;
  readonly recommendedRoute: string;
  readonly policy: string;
}

type McpServerRecord = ReturnType<NonNullable<NonNullable<CommandContext['clients']>['mcpApi']>['listServerSecurity']>[number];

/**
 * MCP server roles that declare browser control. `role` is set deliberately in
 * the server's configuration, so it is a statement rather than a guess. Server
 * names and descriptions are never scanned: a server called "browser-notes"
 * must not become a browser-control provider because of its name.
 */
const BROWSER_CONTROL_MCP_ROLES = new Set(['browser']);

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function quoteRouteValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Registered tools whose definition states the capability, in a stable order. */
function toolsDeclaring(definitions: readonly ToolDefinition[], capability: ToolCapability): readonly string[] {
  return definitions.filter(definition => definition.capabilities?.includes(capability) === true)
    .map(definition => definition.name).sort((left, right) => left.localeCompare(right));
}

function safeToolDefinitions(toolRegistry: ToolRegistry | undefined): readonly ReturnType<ToolRegistry['getToolDefinitions']>[number][] {
  if (!toolRegistry) return [];
  try {
    return toolRegistry.getToolDefinitions();
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function safeMcpServers(context: CommandContext): readonly McpServerRecord[] {
  try {
    const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
    return api?.listServerSecurity?.() ?? [];
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function describeMcpServer(server: McpServerRecord): BrowserControlMcpServer {
  const ready = server.connected && server.schemaFreshness === 'fresh' && server.trustMode !== 'blocked';
  return {
    name: server.name,
    connected: server.connected,
    role: server.role,
    trustMode: server.trustMode,
    schemaFreshness: server.schemaFreshness,
    readiness: ready ? 'ready' : 'attention',
    modelRoute: `agent_harness mode:"mcp_server" mcpServerId:"${server.name}"`,
  };
}

function workflowStatus(configured: boolean, needsReview: boolean): BrowserControlStatus {
  if (configured) return 'ready';
  return needsReview ? 'attention' : 'setup-needed';
}

/**
 * The three things a person may want, each with its own truthful status:
 * browser navigation and screenshots need an invocable browser route; desktop
 * control needs a registered tool that declares it, and is `unavailable` otherwise.
 */
function browserControlWorkflows(
  configured: boolean,
  needsReview: boolean,
  recommendedRoute: string,
  setupRoute: string,
  desktopTools: readonly string[],
): readonly BrowserControlWorkflow[] {
  const status = workflowStatus(configured, needsReview);
  const inspectRoute = configured ? recommendedRoute : setupRoute;
  const next = configured
    ? `Call ${recommendedRoute}, this route is invocable now.`
    : needsReview
      ? 'Review trust/schema freshness before treating this browser connector as usable.'
      : 'Configure a trusted browser MCP server or first-class tool before attempting live UI control.';
  const desktopRoute = desktopTools[0] ? `agent_harness mode:"tool" toolName:"${quoteRouteValue(desktopTools[0])}" includeParameters:true` : '';
  return [
    {
      id: 'browser-navigation',
      label: 'Browser navigation',
      status,
      summary: 'Drive a real browser only when a trusted browser tool or MCP server is configured.',
      next,
      inspectRoute,
      setupRoute,
      safety: BROWSER_CONTROL_SAFETY[0]!,
    },
    {
      id: 'screenshot-observation',
      label: 'Screenshot of a browser page',
      status,
      summary: 'Capture a page through the browser route; screens outside the browser need a desktop-control tool.',
      next,
      inspectRoute,
      setupRoute,
      safety: BROWSER_CONTROL_SAFETY[1]!,
    },
    desktopRoute ? {
      id: 'desktop-control',
      label: 'Desktop control',
      status: 'ready',
      summary: `Control the desktop through ${desktopTools.join(', ')}.`,
      next: `Inspect ${desktopRoute} before acting.`,
      inspectRoute: desktopRoute,
      setupRoute,
      safety: BROWSER_CONTROL_SAFETY[2]!,
    } : {
      id: 'desktop-control',
      label: 'Desktop control',
      status: 'unavailable',
      summary: 'No registered tool declares desktop control, so windows, pointer and keyboard outside a browser cannot be driven from this session.',
      next: 'Use the browser route for anything inside a web page; desktop control needs a tool that declares it.',
      inspectRoute: setupRoute,
      setupRoute,
      safety: BROWSER_CONTROL_SAFETY[2]!,
    },
  ];
}

/** The safety notes, one list for every answer. */
const BROWSER_CONTROL_SAFETY: readonly string[] = [
  'Use read-only web/fetch routes for research unless the user explicitly needs live browser state or authentication.',
  'Screenshots can expose secrets or private data; ask before capturing sensitive surfaces.',
  'Desktop and browser actions are external effects; destructive or account-changing actions require explicit user confirmation.',
];

/**
 * The routes that can be invoked, derived from what is registered right now:
 * the first-class browser tool, and MCP browser tools once the mcp call route
 * exists to invoke them. Nothing is listed on the strength of a keyword match.
 */
function browserInvocationRoutes(
  registry: ToolRegistry | undefined,
  mcpServers: readonly BrowserControlMcpServer[],
): readonly BrowserControlInvocationRoute[] {
  const routes: BrowserControlInvocationRoute[] = [];
  const definitions = safeToolDefinitions(registry);
  const registeredNames = new Set(definitions.map((tool) => tool.name));
  if (toolsDeclaring(definitions, 'browser-control').includes('browser')) {
    routes.push({
      kind: 'first-class-tool',
      toolName: 'browser',
      modelRoute: 'browser action:"navigate" url:"<page url>"',
      summary: 'Drive a real browser directly: navigate, snapshot, click, type, read the page, screenshot. Provisions its own browser on first use.',
    });
  }
  if (registeredNames.has('mcp') && isAgentMcpCallRouteInstalled()) {
    for (const server of mcpServers) {
      if (server.readiness !== 'ready') continue;
      routes.push({
        kind: 'mcp-tool-call',
        toolName: 'mcp',
        modelRoute: `mcp mode:"call" qualifiedName:"mcp:${server.name}:<tool>" input:{...}`,
        summary: `Call a tool on the connected MCP server "${server.name}". List its tools with mcp mode:"tools" serverName:"${server.name}".`,
      });
    }
  }
  return routes;
}

function projectBrowserControlPosture(context: CommandContext, toolRegistry: ToolRegistry | undefined, snapshot: InteractiveRuntimeSnapshot): BrowserControlPosture {
  const registry = toolRegistry ?? context.extensions?.toolRegistry;
  const definitions = safeToolDefinitions(registry);
  const declaredControlTools = toolsDeclaring(definitions, 'browser-control');

  const mcpServers = safeMcpServers(context)
    .filter((server) => BROWSER_CONTROL_MCP_ROLES.has(server.role))
    .map(describeMcpServer)
    .sort((left, right) => left.name.localeCompare(right.name));

  const needsReview = mcpServers.some((server) => server.readiness === 'attention');
  const invocationRoutes = browserInvocationRoutes(registry, mcpServers);
  // Readiness is invocability. A connected MCP server or a tool whose name looks
  // browser-shaped is reported below as context; neither makes this capability usable.
  const configured = invocationRoutes.length > 0;
  const desktopTools = toolsDeclaring(definitions, 'desktop-control');
  // The interactive runtime rows (processes, PTY, sudo) plus the browser/desktop row this posture owns.
  const runtime = {
    ...snapshot.capabilitySummary,
    browserDesktopControl: {
      status: configured ? 'ready' : needsReview ? 'attention' : 'setup-needed',
      routes: invocationRoutes.map((route) => route.modelRoute),
      desktopControl: desktopTools.length > 0 ? 'ready' : 'unavailable',
    },
  };
  const blockers = configured
    ? []
    : [
      'No browser route can be invoked from this session.',
      ...(mcpServers.length > 0 && !isAgentMcpCallRouteInstalled()
        ? ['MCP browser servers are connected but this session has no route that can call them.']
        : []),
      'Fix: the first-class browser tool provides browser control with no setup, if it is missing from the tool list, this build did not register it.',
    ];
  const recommendedRoute = invocationRoutes[0]?.modelRoute ?? 'agent_harness mode:"mcp_servers" query:"browser desktop"';
  const setupRoute = 'setup action:"item" setupItemId:"browser-desktop-control"';
  return {
    status: configured ? 'ready' : needsReview ? 'attention' : 'setup-needed',
    configured,
    needsReview,
    invocationRoutes,
    blockers,
    declaredControlTools,
    toolMatches: declaredControlTools,
    mcpServers,
    runtime,
    workflows: browserControlWorkflows(configured, needsReview, recommendedRoute, setupRoute, desktopTools),
    setupChecklist: [
      'Inspect browser/desktop MCP servers and first-class tools before attempting live UI control.',
      'Prefer constrained trust, fresh schemas, and explicit allowed hosts/paths.',
      'Use web_search or fetch instead when the task only needs public web information.',
      'Ask for confirmation before screenshots, authenticated browsing, account changes, purchases, sends, or destructive desktop actions.',
    ],
    fallbackRoutes: [
      'execution action:"route" id:"web-fetch-research"',
      'agent_harness mode:"mcp_servers" query:"browser desktop"',
    ],
    executionRoute: 'execution action:"route" id:"browser-or-desktop-control"',
    setupRoute,
    recommendedRoute,
    policy: 'Browser and desktop control stays explicit: no live UI control is assumed unless a trusted tool or a fresh constrained MCP server is configured.',
  };
}

/** One look at the registry, the MCP servers and the runtime records; a posture is correct for the moment it was taken. */
export async function captureBrowserControlPosture(context: CommandContext, toolRegistry?: ToolRegistry, options: CatalogRankingOptions = {}): Promise<{
  readonly posture: BrowserControlPosture; readonly assertCurrent: () => void; readonly assertSourceCurrent: () => void;
}> {
  const assertSourceCurrent = (): void => { options.signal?.throwIfAborted(); };
  const assertCurrent = (): void => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const registry = toolRegistry ?? context.extensions?.toolRegistry;
  const snapshot = readInteractiveRuntime(context, options);
  return { posture: projectBrowserControlPosture(context, registry, snapshot), assertCurrent, assertSourceCurrent };
}

export async function browserControlPosture(context: CommandContext, toolRegistry?: ToolRegistry, options: CatalogRankingOptions = {}): Promise<BrowserControlPosture> {
  return (await captureBrowserControlPosture(context, toolRegistry, options)).posture;
}

function toolCandidateRoutes(toolMatches: readonly string[]): readonly Record<string, unknown>[] {
  return toolMatches.slice(0, 8).map((toolName) => ({
    toolName,
    inspectRoute: `agent_harness mode:"tool" toolName:"${quoteRouteValue(toolName)}" includeParameters:true`,
    modelRoute: `${toolName} ...`,
    safety: 'Inspect the tool schema and policy before invoking a live browser, screenshot, or desktop-control action.',
  }));
}

function mcpCandidateRoutes(mcpServers: readonly BrowserControlMcpServer[]): readonly Record<string, unknown>[] {
  return mcpServers.slice(0, 8).map((server) => ({
    serverName: server.name,
    readiness: server.readiness,
    connected: server.connected,
    trustMode: server.trustMode,
    schemaFreshness: server.schemaFreshness,
    inspectRoute: server.modelRoute,
    safety: 'Review trust and schema freshness before using MCP browser or desktop-control tools.',
  }));
}

function browserControlDecision(
  posture: BrowserControlPosture,
  toolRoutes: readonly Record<string, unknown>[],
  mcpRoutes: readonly Record<string, unknown>[],
): BrowserControlDecision {
  const firstToolRoute = readString(toolRoutes[0]?.inspectRoute);
  const firstReadyMcpRoute = readString(mcpRoutes.find((route) => route.readiness === 'ready')?.inspectRoute);
  const firstReviewMcpRoute = readString(mcpRoutes[0]?.inspectRoute);
  if (posture.configured) {
    const route = posture.invocationRoutes[0];
    return {
      id: 'inspect-configured-browser-control',
      status: 'ready-to-inspect-tool',
      modelRoute: route?.modelRoute ?? (firstToolRoute || firstReadyMcpRoute || posture.recommendedRoute || posture.executionRoute),
      userRoute: 'Agent Workspace -> Work & Approvals or Tools & MCP',
      nextStep: route
        ? `Call ${route.modelRoute} directly, replacing any <placeholder> with a real value. ${route.summary}`
        : 'Inspect the configured browser tool/server before acting.',
      reason: route
        ? route.kind === 'mcp-tool-call'
            ? 'The mcp tool is registered and a connected MCP browser server has fresh schemas and a trusted mode.'
            : `${route.toolName} is registered and can be invoked from this session.`
        : 'A browser/desktop control tool or fresh trusted MCP server is configured.',
      safety: BROWSER_CONTROL_SAFETY[2]!,
    };
  }
  if (posture.needsReview) {
    return {
      id: 'review-browser-control-connector',
      status: 'review-connector-first',
      modelRoute: firstReviewMcpRoute || 'computer action:"mcp" query:"browser desktop" includeParameters:true',
      userRoute: 'Agent Workspace -> Tools & MCP',
      nextStep: 'Review connector trust, connectivity, and schema freshness before treating browser or desktop control as available.',
      reason: 'A browser/desktop connector exists but needs trust, connectivity, or schema review.',
      safety: 'Do not use stale or untrusted browser/desktop connectors for screenshots, authenticated pages, or desktop actions.',
    };
  }
  return {
    id: 'setup-browser-control',
    status: 'setup-needed',
    modelRoute: posture.setupRoute,
    userRoute: 'Agent Workspace -> Start',
    nextStep: 'Configure a trusted browser/desktop tool or MCP server, or use the public web/fetch fallback when live UI state is not required.',
    reason: 'No trusted browser/desktop control tool or fresh MCP server is configured.',
    safety: 'This planner does not open, observe, or control the browser or desktop.',
  };
}

/**
 * The browser/desktop posture, answered from code: what can be invoked now,
 * what blocks it, and one fixed list of safety notes. A query or target is
 * echoed, never ranked: every row leads to the same route.
 */
export async function browserControlRouteSummary(
  context: CommandContext,
  toolRegistry: ToolRegistry,
  args: BrowserControlRouteArgs,
  options: CatalogRankingOptions = {},
): Promise<Record<string, unknown>> {
  const input = readString(args.query) || readString(args.target);
  const includeParameters = args.includeParameters === true;
  const { posture, assertCurrent } = await captureBrowserControlPosture(context, toolRegistry, options);
  const toolRoutes = toolCandidateRoutes(posture.toolMatches);
  const mcpRoutes = mcpCandidateRoutes(posture.mcpServers);
  const decision = browserControlDecision(posture, toolRoutes, mcpRoutes);
  assertCurrent();
  return {
    mode: 'browser_control_route',
    request: input || null,
    status: posture.status,
    configured: posture.configured,
    needsReview: posture.needsReview,
    invocationRoutes: posture.invocationRoutes,
    ...(posture.blockers.length > 0 ? { blockers: posture.blockers } : {}),
    capabilities: posture.workflows.map(({ id, label, status, next }) => ({ id, label, status, next })),
    decision,
    toolCandidates: toolRoutes,
    mcpCandidates: mcpRoutes,
    fallbackRoutes: posture.fallbackRoutes,
    safety: BROWSER_CONTROL_SAFETY,
    routes: {
      controlPosture: 'computer action:"control" includeParameters:true',
      setup: posture.setupRoute,
      mcpReview: 'computer action:"mcp" query:"browser desktop" includeParameters:true',
      publicWebFallback: posture.fallbackRoutes[0] ?? 'execution action:"route" id:"web-fetch-research"',
    },
    ...(includeParameters ? { posture } : {}),
    policy: {
      effect: 'read-only-route-plan',
      boundary: 'This route reports browser and desktop control only. It never opens a browser, captures a screenshot, controls the desktop, or invokes a browser/MCP tool by itself.',
      confirmation: 'Live browser, screenshot, authenticated browsing, account-changing, purchase, send, or destructive desktop actions require the selected tool-specific confirmation boundary and explicit user request.',
    },
  };
}

import { resolveWebSurfaceExposure } from '@goodvibes/engine/platform/platform/support/service-posture';
import { resolveConnectedHostAddress } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { resolveRuntimeEndpointBinding } from '../cli/endpoints.ts';
import { inspectCliExternalRuntime, type CliExternalRuntimeSnapshot } from '../cli/external-runtime.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { readConnectedHostOperatorToken } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-auth';
import { harnessDisplayPath } from './agent-harness-display-path.ts';
import { CONNECTED_HOST_LIFECYCLE_STATEMENT, CONNECTED_HOST_OWNERSHIP, gatedConnectedHostCapabilities } from './agent-harness-connected-host-capabilities.ts';
import { EFFECT_ADMISSION_SENTENCE } from '@goodvibes/engine/terminal-shell/agent-turn/effect-admission';
import {
  blockedConnectedHostCapabilities,
  connectedHostCapabilityMap,
  connectedHostRouteFamilies,
} from './agent-harness-metadata.ts';

const CONNECTED_HOST_STATUS_TIMEOUT_MS = 1500;

function resolveHomeDirectory(context: CommandContext): string {
  return context.workspace.shellPaths?.homeDirectory
    ?? context.platform.configManager.getHomeDirectory()
    ?? '';
}

function resolveWorkingDirectory(context: CommandContext): string {
  return context.workspace.shellPaths?.workingDirectory
    ?? context.platform.configManager.getWorkingDirectory()
    ?? '';
}

function connectedHostFindings(
  runtime: CliExternalRuntimeSnapshot,
  tokenUsable: boolean,
  tokenPath: string,
): readonly Record<string, unknown>[] {
  const findings: Record<string, unknown>[] = [];

  if (!runtime.reachable) {
    findings.push({
      id: 'connected-host-unreachable',
      severity: 'warning',
      summary: 'Connected host is not reachable.',
      cause: runtime.error ?? `No response from ${runtime.baseUrl}.`,
      action: 'Start or repair the owning GoodVibes host outside Agent, then recheck connected-host status.',
    });
  } else if (!runtime.compatible) {
    findings.push({
      id: 'connected-host-incompatible',
      severity: 'warning',
      summary: 'Connected host compatibility does not satisfy Agent readiness.',
      cause: 'Connected host is reachable, but at least one public Agent route is unavailable or incompatible.',
      action: 'Update the owning GoodVibes host so its public Agent routes are compatible.',
    });
  }

  if (!tokenUsable) {
    findings.push({
      id: 'connected-host-token-missing',
      severity: 'warning',
      summary: 'Connected-host operator token is missing or unreadable.',
      cause: `No usable operator token was found at ${tokenPath}.`,
      action: 'Provision or repair connected-host access through the owning GoodVibes host.',
    });
  }

  if (runtime.reachable && tokenUsable && !runtime.agentKnowledge.ready) {
    findings.push({
      id: 'agent-knowledge-route-not-ready',
      severity: 'warning',
      summary: 'Isolated Agent Knowledge route is not ready.',
      cause: `${runtime.agentKnowledge.route} returned ${runtime.agentKnowledge.kind}${runtime.agentKnowledge.statusCode === null ? '' : ` (${runtime.agentKnowledge.statusCode})`}.`,
      action: 'Update or repair the connected host, then recheck Agent Knowledge compatibility.',
    });
  }

  return findings;
}

/** What the last host status read found for the Agent Knowledge route, for the setup plan to report without probing again. */
export interface AgentKnowledgeReadiness {
  readonly ready: boolean;
  readonly reachable: boolean;
  readonly route: string;
  readonly kind: string;
  readonly checkedAt: number;
}

let lastAgentKnowledgeReadiness: AgentKnowledgeReadiness | null = null;

/** The Agent Knowledge readiness `host action:"status"` last observed in this process, or null when it has not run. */
export function latestAgentKnowledgeReadiness(): AgentKnowledgeReadiness | null {
  return lastAgentKnowledgeReadiness;
}

export async function connectedHostStatusSummary(
  context: CommandContext,
  toolRegistry: ToolRegistry,
  options: { readonly includeParameters?: boolean } = {},
): Promise<Record<string, unknown>> {
  const homeDirectory = resolveHomeDirectory(context);
  const workingDirectory = resolveWorkingDirectory(context);
  const token = readConnectedHostOperatorToken(homeDirectory, resolveConnectedHostAddress(context.platform.configManager).baseUrl);
  const runtime = await inspectCliExternalRuntime({
    configManager: context.platform.configManager,
    homeDirectory,
    timeoutMs: CONNECTED_HOST_STATUS_TIMEOUT_MS,
  });
  const tokenUsable = Boolean(token.token);
  const tokenPath = harnessDisplayPath(token.path, homeDirectory);
  lastAgentKnowledgeReadiness = { ready: runtime.reachable && runtime.agentKnowledge.ready, reachable: runtime.reachable,
    route: runtime.agentKnowledge.route, kind: String(runtime.agentKnowledge.kind), checkedAt: Date.now() };

  return {
    ownership: CONNECTED_HOST_OWNERSHIP,
    readOnly: true,
    modelRoute: 'host action:"status" or action:"services"',
    compatibilityRoutes: {
      modelRoute: 'agent_harness mode:"connected_host_status" or mode:"service_posture"',
    },
    timeoutMs: CONNECTED_HOST_STATUS_TIMEOUT_MS,
    lifecycle: CONNECTED_HOST_LIFECYCLE_STATEMENT,
    paths: {
      workingDirectory: harnessDisplayPath(workingDirectory, homeDirectory),
      homeDirectory: '~',
    },
    endpoints: {
      controlPlane: {
        enabled: context.platform.configManager.get('controlPlane.enabled'),
        ...resolveRuntimeEndpointBinding(context.platform.configManager, 'controlPlane'),
      },
      httpListener: {
        enabled: context.platform.configManager.get('danger.httpListener'),
        ...resolveRuntimeEndpointBinding(context.platform.configManager, 'httpListener'),
      },
      // Where the web UI is served (the control-plane listener) or not; web.* is only a development server's.
      web: (() => {
        const exposure = resolveWebSurfaceExposure(context.platform.configManager);
        const switchedOn = context.platform.configManager.get('web.enabled') === true;
        return {
          enabled: switchedOn && exposure.served,
          ...exposure.binding,
          served: exposure.served,
          networkFacing: switchedOn && exposure.networkFacing,
          developmentEndpoint: resolveRuntimeEndpointBinding(context.platform.configManager, 'web'),
        };
      })(),
    },
    operatorToken: {
      present: token.present,
      usable: tokenUsable,
      path: tokenPath,
      error: token.error ?? null,
    },
    liveStatus: { ...runtime, operatorToken: { ...runtime.operatorToken, path: tokenPath } },
    routeReadiness: [
      {
        id: 'status',
        route: '/status',
        reachable: runtime.reachable,
        statusCode: runtime.statusCode,
        compatible: runtime.compatible,
      },
      {
        id: 'agent-knowledge',
        route: runtime.agentKnowledge.route,
        ready: runtime.agentKnowledge.ready,
        kind: runtime.agentKnowledge.kind,
        statusCode: runtime.agentKnowledge.statusCode,
      },
    ],
    findings: connectedHostFindings(runtime, tokenUsable, tokenPath),
    capabilitySummary: {
      routeFamilies: connectedHostRouteFamilies().length,
      availableCapabilities: connectedHostCapabilityMap(toolRegistry).filter((capability) => capability.available === true).length,
      gatedCapabilities: gatedConnectedHostCapabilities().length,
      blockedCapabilities: blockedConnectedHostCapabilities().length,
    },
    ...(options.includeParameters ? { modelAccess: {
      diagnostics: 'Use host action:"status" for live readiness, action:"services|service" for endpoint posture, and action:"capabilities|capability" for capability inventory.',
      daemonAliases: 'mode:"daemon_status" is an alias for mode:"connected_host_status"; mode:"daemon" is an alias for mode:"connected_host".',
      lifecycle: `Use setup or agent_operator_method for supported daemon service methods. ${EFFECT_ADMISSION_SENTENCE}`,
      cliMirrors: ['goodvibes-agent status --json', 'goodvibes-agent doctor', 'goodvibes-agent compat'],
      tuiMirrors: ['System place, Health', 'Agent Workspace -> Connected Host'],
    },
    routeFamilies: connectedHostRouteFamilies(),
    capabilities: connectedHostCapabilityMap(toolRegistry),
    gatedCapabilities: gatedConnectedHostCapabilities(new Set(toolRegistry.getToolDefinitions().map((tool) => tool.name))),
    blockedCapabilities: blockedConnectedHostCapabilities() } : {}),
  };
}

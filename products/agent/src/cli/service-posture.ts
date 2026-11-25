/**
 * The Agent's posture toward the host it connects to. The facts are read once, in the platform
 * (platform/support/service-posture.ts `buildConnectedHostServicePosture`), which the daemon's support bundle reads
 * too; this file gives it the Agent's own way of trying an endpoint and prints it.
 */
import {
  buildConnectedHostServicePosture,
  type ConnectedHostServicePosture,
  type CliServiceRuntime,
  type CliServiceEndpointPosture,
} from '@goodvibes/engine/platform/platform/support/service-posture';
export type {
  CliServiceRuntime,
  CliServiceEndpointPosture,
  CliServiceLogPosture,
} from '@goodvibes/engine/platform/platform/support/service-posture';
import { yesNo } from '@goodvibes/engine/terminal-shell/cli-output';
import { probeTcp as probe } from '@goodvibes/engine/terminal-shell/service-io';
import { resolveConnectedHostDialEnabled } from '@goodvibes/engine/platform/platform/config';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { dialHostForConfiguredHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';

export type CliServicePosture = ConnectedHostServicePosture;

interface CliServicePostureOptions extends JudgmentReadingOptions {
  readonly probe?: boolean;
  readonly logTailBytes?: number;
}

/** A TCP probe from this process, so a wildcard bind resolves to loopback. */
function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return probe(host, port, timeoutMs, dialHostForConfiguredHost);
}

export function buildCliServicePosture(runtime: CliServiceRuntime, options: CliServicePostureOptions = {}): Promise<CliServicePosture> {
  return buildConnectedHostServicePosture(runtime, { ...options, probeTcp, logSite: 'agent.cli.service-log' });
}

/**
 * One endpoint's reachability, probed only when it is enabled, its binding is
 * recognized and this surface may dial the connected host: the same rule the
 * full posture applies to every endpoint.
 */
export async function probeCliServiceEndpoint(runtime: CliServiceRuntime, endpoint: CliServiceEndpointPosture): Promise<CliServiceEndpointPosture> {
  if (!endpoint.enabled || !endpoint.binding.recognized || !resolveConnectedHostDialEnabled(runtime.configManager)) return endpoint;
  return { ...endpoint, reachable: await probeTcp(endpoint.binding.host, endpoint.binding.port) };
}

export function formatCliServicePosture(posture: CliServicePosture, json = false): string {
  if (json) return JSON.stringify(posture, null, 2);
  return [
    'GoodVibes Agent connected-host diagnostics',
    '  lifecycle owner: outside goodvibes-agent',
    '  Agent starts connected host: only at boot, when it is installed but stopped',
    `  external host config present: ${yesNo(posture.config.enabled)}`,
    '  external host lifecycle config: only the service name is read, for the boot start check',
    `  adopts a daemon of its own: ${yesNo(posture.config.daemonEnabled)}`,
    `  may dial the connected host: ${yesNo(posture.config.connectedHostDialEnabled)}`,
    `  log: ${posture.log.path ?? 'n/a'} (${posture.log.exists ? 'present' : 'missing'})`,
    ...(posture.log.readError ? [`  log read error: ${posture.log.readError}`] : []),
    '',
    'Connected API checks',
    ...posture.endpoints.map(
      (endpoint) =>
        `  ${endpoint.label} enabled ${yesNo(endpoint.enabled)}  ${endpoint.binding.hostMode} ${endpoint.binding.host}:${endpoint.binding.port}  posture ${endpoint.bindPosture.label}${endpoint.reachable === undefined ? '' : `  reachable ${yesNo(endpoint.reachable)}`}`,
    ),
    '',
    posture.issues.length === 0 ? 'Readiness ready' : 'Readiness needs attention',
    ...posture.issues.map((issue) => `  - ${issue}`),
    ...(posture.advisories.length > 0 ? ['', 'Notes', ...posture.advisories.map((advisory) => `  - ${advisory}`)] : []),
  ].join('\n');
}

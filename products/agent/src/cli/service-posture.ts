import {
  readServiceLogPosture,
  retainServicePostureInput,
  readServiceEndpoints,
  serviceEndpointFindings,
  serviceLogUnreadableFinding,
  type ServiceFinding,
  type CliServiceRuntime,
  type CliServiceEndpointPosture,
  type CliServiceLogPosture,
} from '@goodvibes-jev/engine/terminal-shell/service-posture';
export type {
  CliServiceRuntime,
  CliServiceEndpointPosture,
  CliServiceLogPosture,
} from '@goodvibes-jev/engine/terminal-shell/service-posture';
import { yesNo } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { probeTcp as probe } from '@goodvibes-jev/engine/terminal-shell/service-io';
import { isAbsolute, join } from 'node:path';
import { resolveConnectedHostDialEnabled, resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import type { ConfigKey } from '../config/index.ts';
import type { RuntimeEndpointId } from './endpoints.ts';
import { captureJudgmentPort, type JudgmentPortCapture, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { retainCliConfig } from '@goodvibes-jev/engine/terminal-shell/cli-config-owner';
import { dialHostForConfiguredHost } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-dial';
import { isClassicOperation } from '@goodvibes-jev/engine/platform/platform/runtime/decision-policy';

export interface CliServicePosture {
  readonly config: {
    readonly enabled: boolean;
    readonly autostart: boolean;
    readonly restartOnFailure: boolean;
    /** `daemon.enabled`, whether this surface adopts a session daemon of its own. */
    readonly daemonEnabled: boolean;
    /**
     * `daemon.connectedHost.enabled`, whether this surface may DIAL the host
     * it is connected to. Reported separately because it is what the
     * daemon-backed features actually consult; reporting only the adopt flag
     * described a machine that was not the one running.
     */
    readonly connectedHostDialEnabled: boolean;
  };
  readonly endpoints: readonly CliServiceEndpointPosture[];
  readonly log: CliServiceLogPosture;
  readonly issues: readonly string[];
  /** The same issues as whole records (summary, cause, impact, one remedy): what doctor prints. */
  readonly findings: readonly ServiceFinding[];
  /**
   * Observations that describe the INTENDED arrangement rather than a fault.
   *
   * Kept apart from `issues` because everything in that array is rendered as a
   * problem, with a cause and an impact that say something may be unavailable.
   * That is the wrong sentence for a posture that is working as designed, and
   * the difference matters at release time: an advisory must not be able to
   * turn a strict verification red.
   */
  readonly advisories: readonly string[];
}

const ENDPOINTS: readonly { readonly id: RuntimeEndpointId; readonly label: string; readonly enabledKey: ConfigKey }[] = [
  { id: 'controlPlane', label: 'runtime connection', enabledKey: 'controlPlane.enabled' },
  { id: 'httpListener', label: 'inbound events endpoint', enabledKey: 'danger.httpListener' },
  { id: 'web', label: 'browser companion route', enabledKey: 'web.enabled' },
];

interface CliServicePostureOptions extends JudgmentReadingOptions {
  readonly probe?: boolean;
  readonly logTailBytes?: number;
}

/** A TCP probe from this process, so a wildcard bind resolves to loopback. */
const connectHostForBindHost = dialHostForConfiguredHost;

function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return probe(host, port, timeoutMs, connectHostForBindHost);
}

function resolveConfiguredLogPath(runtime: CliServiceRuntime): string | undefined {
  const value = runtime.configManager.get('service.logPath');
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return isAbsolute(trimmed) ? trimmed : join(runtime.homeDirectory, trimmed);
}

export async function buildCliServicePosture(
  runtime: CliServiceRuntime,
  options: CliServicePostureOptions = {},
): Promise<CliServicePosture> {
  const retainedConfig = retainCliConfig(runtime.configManager);
  const assertCurrent = retainServicePostureInput(
    runtime,
    options,
    () => {
      try {
        retainedConfig.assertCurrent();
      } catch {
        throw new Error('Service posture input changed before publication.');
      }
    },
    'Service posture input changed before publication.',
  );
  const reading = { ...options, assertCurrent };
  assertCurrent();
  const endpoints = await readServiceEndpoints(runtime, ENDPOINTS, {
    probe: options.probe,
    assertCurrent,
    probeTcp,
    mayProbe: () => resolveConnectedHostDialEnabled(runtime.configManager),
  });

  const config = {
    enabled: runtime.configManager.get('service.enabled') === true,
    autostart: runtime.configManager.get('service.autostart') === true,
    restartOnFailure: runtime.configManager.get('service.restartOnFailure') === true,
    daemonEnabled: resolveDaemonEnabled(runtime.configManager),
    connectedHostDialEnabled: resolveConnectedHostDialEnabled(runtime.configManager),
  };
  // Dialing is what the daemon-backed features consult, so a machine that does
  // not adopt a daemon but does dial a connected one is server-backed, which
  // is exactly the topology this product is designed for.
  const serverBackedEnabled = config.daemonEnabled || config.connectedHostDialEnabled || endpoints.some((endpoint) => endpoint.enabled);
  const findings: ServiceFinding[] = [];
  const advisories: string[] = [];

  if (serverBackedEnabled && !config.enabled) {
    // Not a fault. The Agent is designed not to own the host, a connected
    // GoodVibes daemon does, so this is the normal topology, and it became
    // visible here only once the Agent began reading the shared daemon tier.
    advisories.push('Connected-host settings are present, but Agent host ownership is disabled by design.');
  }
  findings.push(...serviceEndpointFindings(endpoints, options.probe));
  const configuredLogPath = resolveConfiguredLogPath(runtime);
  let logOwner: JudgmentPortCapture | undefined;
  const logReading = {
    ...reading,
    assertCurrent: () => {
      assertCurrent();
      if (!isClassicOperation()) logOwner?.assertCurrent();
    },
  };
  const log = await readServiceLogPosture(configuredLogPath, options.logTailBytes ?? 4096, logReading, () => {
    logOwner = captureJudgmentPort('agent.cli.service-log', reading);
  });
  if (log.readError) {
    findings.push(serviceLogUnreadableFinding(log.readError));
  }

  assertCurrent();
  if (!isClassicOperation()) logOwner?.assertCurrent();
  return {
    config,
    endpoints,
    log,
    issues: findings.map((finding) => finding.summary),
    findings,
    advisories,
  };
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

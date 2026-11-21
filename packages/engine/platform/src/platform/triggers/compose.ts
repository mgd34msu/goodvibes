/**
 * compose.ts, the one way a product builds its trigger supervisor.
 *
 * Every host composes the family the same way: settings read live from the
 * config manager (so `watchers.triggers.*` takes effect on the next read),
 * the process manager behind on-exit children, stream commands and command
 * probes (credential scrub, private process groups, bounded output), and the
 * agent manager behind fired agent turns. Turning `watchers.triggers.enabled`
 * on starts supervision of stored triggers at once.
 */

import type { ConfigManager } from '../config/manager.js';
import type { ProcessManager } from '../tools/shared/process-manager.js';
import { createBunStreamHost, createProcessManagerCommandRunner, createProcessManagerTriggerHost, createTriggerActionExecutor, type TriggerAgentSpawner } from './hosts.js';
import { TriggerManager, type TriggerManagerConfig } from './manager.js';
import { createDefaultProbeIo, type ProbeHostPolicy } from './probes.js';
import { createConfiguredFetchDeps } from '../tools/fetch/runtime-deps.js';
import type { UnattendedRuns } from '../automation/unattended-runs.js';
import { ProbeToolHost } from './probe-tools.js';

export interface TriggerSupervisorDeps {
  readonly configManager: Pick<ConfigManager, 'get' | 'subscribe'>;
  /** Resolves a file in this surface's project directory (`<project>/.goodvibes/<surface>/<name>`). */
  readonly resolveStorePath: (name: string) => string;
  readonly agents: TriggerAgentSpawner;
  readonly processManager: ProcessManager;
  /** Where a fired turn's answer goes, and the connected tools (mail, calendar) it gets. */
  readonly unattendedRuns?: UnattendedRuns | undefined;
  /** False when the session that created a trigger is gone; such triggers are reaped. */
  readonly sessionIsLive?: ((sessionId: string) => boolean) | undefined;
  /** Whether new work is admitted (daemon/work-admission.ts); no action fires while it is not. */
  readonly workAdmitted?: (() => boolean) | undefined;
}

/** The live `watchers.triggers.*` settings. */
export function readTriggerConfig(configManager: Pick<ConfigManager, 'get'>): TriggerManagerConfig {
  return {
    enabled: configManager.get('watchers.triggers.enabled'),
    backoffLadderMs: configManager.get('watchers.triggers.backoffLadderMs'),
    breakerStrikes: configManager.get('watchers.triggers.breakerStrikes'),
    defaultCheckIntervalMs: configManager.get('watchers.triggers.defaultCheckIntervalMs'),
    probeTimeoutMs: configManager.get('watchers.triggers.probeTimeoutMs'),
    maxConcurrentChecks: configManager.get('watchers.triggers.maxConcurrentChecks'),
    observationRingSize: configManager.get('watchers.triggers.observationRingSize'),
    runHistoryLimit: configManager.get('watchers.triggers.runHistoryLimit'),
    runHistoryTtlHours: configManager.get('watchers.triggers.runHistoryTtlHours'),
    eventLogLimit: configManager.get('watchers.triggers.eventLogLimit'),
    eventLogTtlHours: configManager.get('watchers.triggers.eventLogTtlHours'),
    sweepIntervalMs: configManager.get('watchers.triggers.sweepIntervalMs'),
    supervisionTickMs: configManager.get('watchers.triggers.supervisionTickMs'),
    streamQueueLimit: configManager.get('watchers.triggers.streamQueueLimit'),
    streamBatchLines: configManager.get('watchers.triggers.streamBatchLines'),
    streamBatchIntervalMs: configManager.get('watchers.triggers.streamBatchIntervalMs'),
    onExitMaxDurationMs: configManager.get('watchers.triggers.onExitMaxDurationMs'),
    onExitStdin: configManager.get('watchers.triggers.onExitStdin'),
    outputTailBytes: configManager.get('watchers.triggers.outputTailBytes'),
  };
}

/**
 * Builds the supervisor. `start()` is the host's to call at boot (it does
 * nothing until the family is on and a trigger is stored); turning the
 * setting on later starts it without a restart.
 */
export function createTriggerSupervisor(deps: TriggerSupervisorDeps): TriggerManager {
  const { configManager, processManager } = deps;
  // Platform-tool probes call the tools of the sessions whose registries attach here (attachProbeTools).
  const probeTools = new ProbeToolHost();
  // An http probe is held to the fetch tool's own host settings, read live.
  const fetchDeps = createConfiguredFetchDeps({ serviceRegistry: null, featureFlags: null, configManager });
  const hostList = (value: readonly string[] | (() => readonly string[] | undefined) | undefined): readonly string[] | undefined =>
    typeof value === 'function' ? value() : value;
  const hostPolicy: ProbeHostPolicy = {
    trustedHosts: () => hostList(fetchDeps.defaultTrustedHosts),
    blockedHosts: () => hostList(fetchDeps.defaultBlockedHosts),
    localhostAllowed: () => fetchDeps.isLocalhostAllowed?.() === true,
    allowedPrivateHosts: () => fetchDeps.allowedPrivateHosts?.() ?? [],
  };
  const manager = new TriggerManager({
    storePath: deps.resolveStorePath('triggers.db'),
    config: () => readTriggerConfig(configManager),
    actions: createTriggerActionExecutor({ agents: deps.agents, processManager, unattendedRuns: deps.unattendedRuns }),
    processHost: createProcessManagerTriggerHost(processManager),
    streamHost: createBunStreamHost(processManager),
    probeIo: createDefaultProbeIo({
      runCommand: createProcessManagerCommandRunner(processManager),
      callTool: (tool, input, timeoutMs, ownerSessionId) => probeTools.call(tool, input, timeoutMs, ownerSessionId),
      hostPolicy,
    }),
    probeHostPolicy: hostPolicy,
    probeTools,
    ...(deps.sessionIsLive ? { sessionIsLive: deps.sessionIsLive } : {}),
    ...(deps.workAdmitted ? { workAdmitted: deps.workAdmitted } : {}),
    watchEnabled: (onChange) => configManager.subscribe('watchers.triggers.enabled', (enabled) => { onChange(enabled === true); }),
  });
  return manager;
}

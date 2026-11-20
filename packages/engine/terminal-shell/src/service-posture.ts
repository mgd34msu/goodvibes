import { closeSync, existsSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { resolveRuntimeEndpointBinding, type RuntimeEndpointBinding, type RuntimeEndpointId } from './cli-endpoints.js';
import { classifyBindPosture, isNetworkFacing, resolveWebSurfaceExposure } from './cli-network-posture.js';
import { redactText } from './cli-redaction.js';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime/decision-policy';
export interface CliServiceRuntime {
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

export interface CliServiceEndpointPosture {
  readonly id: RuntimeEndpointId;
  readonly label: string;
  readonly enabled: boolean;
  readonly binding: RuntimeEndpointBinding;
  readonly bindPosture: ReturnType<typeof classifyBindPosture>;
  readonly networkFacing: boolean;
  /** For an endpoint that always serves this machine while it runs: whether other machines are served too. */
  readonly servesOtherMachines?: boolean;
  readonly reachable?: boolean;
}

export interface CliServiceLogPosture {
  readonly provenance?: 'classic';
  readonly path: string | null;
  readonly exists: boolean;
  readonly size: number;
  readonly modifiedAt: number | null;
  readonly tail?: string;
  readonly readError?: string;
}
export async function readServiceLogPosture(
  path: string | undefined,
  tailBytes: number,
  options: JudgmentReadingOptions,
  captureOwner?: () => void,
): Promise<CliServiceLogPosture> {
  return withConfiguredDecisionModelPolicy(() => readOwnedServiceLogPosture(path, tailBytes, options, captureOwner));
}
async function readOwnedServiceLogPosture(path: string | undefined, tailBytes: number, options: JudgmentReadingOptions, captureOwner?: () => void): Promise<CliServiceLogPosture> {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  if (!path) return { path: null, exists: false, size: 0, modifiedAt: null };
  if (!existsSync(path)) return { path, exists: false, size: 0, modifiedAt: null };
  let captured: { readonly stat: Stats; readonly text: string };
  try {
    const stat = statSync(path);
    const length = Math.min(stat.size, Math.max(0, tailBytes));
    if (length === 0) {
      return { path, exists: true, size: stat.size, modifiedAt: stat.mtimeMs, tail: '' };
    }
    const raw = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    let read: number;
    try {
      read = readSync(fd, raw, 0, length, Math.max(0, stat.size - length));
    } finally {
      closeSync(fd);
    }
    // A file truncated since the stat returns fewer bytes than asked; the rest
    // of the buffer is zero padding, not log text.
    let start = 0;
    // The tail begins mid-file, possibly inside a multi-byte character.
    if (stat.size > length) while (start < read && (raw[start]! & 0xc0) === 0x80) start++;
    captured = { stat, text: raw.subarray(start, read).toString('utf-8') };
  } catch {
    return {
      path,
      exists: true,
      size: 0,
      modifiedAt: null,
      readError: 'Service log could not be read.',
    };
  }
  const ownersCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
  };
  // The service keeps appending while a model-backed redaction runs, so growth
  // is expected. A different file (rotation) or a shorter one (truncation) means
  // the captured bytes no longer describe the log.
  const logReplaced = (): boolean => {
    let current: Stats;
    try {
      current = statSync(path);
    } catch {
      return true; // removed or unreadable: not the file that was captured
    }
    const original = captured.stat;
    return current.dev !== original.dev || current.ino !== original.ino || current.size < original.size;
  };
  const changed: CliServiceLogPosture = {
    path,
    exists: true,
    size: captured.stat.size,
    modifiedAt: captured.stat.mtimeMs,
    readError: 'Service log changed while it was read.',
  };
  class LogReplaced extends Error {}
  const assertCurrent = () => {
    ownersCurrent();
    if (logReplaced()) throw new LogReplaced('Service log changed during redaction.');
  };
  let tail: string;
  try {
    tail = await decisionOrClassic(() => {
      captureOwner?.();
      return redactText(captured.text, { ...options, assertCurrent });
    }, () => redactText(captured.text, { ...options, assertCurrent }));
  } catch (error) {
    // Cancellation and revoked ownership still prevent the entire publication.
    ownersCurrent();
    if (error instanceof LogReplaced || logReplaced()) return changed;
    // Withhold the captured bytes when redaction is unavailable.
    return { path, exists: true, size: captured.stat.size, modifiedAt: captured.stat.mtimeMs, readError: 'Service log could not be read safely.' };
  }
  ownersCurrent();
  if (logReplaced()) return changed;
  return { path, exists: true, size: captured.stat.size, modifiedAt: captured.stat.mtimeMs, tail,
    ...(isClassicOperation() ? { provenance: 'classic' as const } : {}) };
}

/** Revalidate retained configuration and synchronous ownership before publishing diagnostics. */
export function retainServicePostureInput(
  runtime: CliServiceRuntime,
  options: JudgmentReadingOptions,
  assertConfigCurrent: () => void,
  message: string,
): () => void {
  const { configManager, workingDirectory, homeDirectory } = runtime;
  const signal = options.signal,
    callerCurrent = options.assertCurrent;
  const sourceCurrent = () => {
    signal?.throwIfAborted();
    if (
      options.signal !== signal ||
      options.assertCurrent !== callerCurrent ||
      runtime.configManager !== configManager ||
      runtime.workingDirectory !== workingDirectory ||
      runtime.homeDirectory !== homeDirectory
    )
      throw new Error(message);
    assertConfigCurrent();
  };
  return () => {
    sourceCurrent();
    assertSynchronousJudgmentGuard(callerCurrent, () => new Error('Service posture ownership must be synchronous.'));
    sourceCurrent();
  };
}

export async function readServiceEndpoints(
  runtime: CliServiceRuntime,
  definitions: readonly {
    readonly id: RuntimeEndpointId;
    readonly label: string;
    readonly enabledKey: Parameters<ConfigManager['get']>[0];
    /**
     * Whether the endpoint listens, when one setting does not say it alone (the
     * control plane listens whenever the daemon runs: `resolveDaemonEnabled`).
     * Absent: `enabledKey` is true.
     */
    readonly isEnabled?: ((config: Pick<ConfigManager, 'get'>) => boolean) | undefined;
    /**
     * The setting that says whether other machines are served too, for an
     * endpoint that serves this machine whenever it listens
     * (`controlPlane.enabled`). Only that makes it network-facing.
     */
    readonly servesOtherMachinesKey?: Parameters<ConfigManager['get']>[0] | undefined;
  }[],
  options: {
    readonly probe: boolean | undefined;
    readonly mayProbe: (binding: RuntimeEndpointBinding) => boolean;
    readonly probeTcp: (host: string, port: number) => Promise<boolean>;
    readonly assertCurrent: () => void;
  },
): Promise<CliServiceEndpointPosture[]> {
  options.assertCurrent();
  const endpoints = await Promise.all(
    definitions.map(async (endpoint) => {
      const switchedOn = endpoint.isEnabled ? endpoint.isEnabled(runtime.configManager) : runtime.configManager.get(endpoint.enabledKey) === true;
      // The web UI listens only where it is served: the control-plane listener
      // while the daemon serves the bundle, nowhere otherwise (web.* is a development server's).
      const web = endpoint.id === 'web' ? resolveWebSurfaceExposure(runtime.configManager) : undefined;
      const enabled = web === undefined ? switchedOn : switchedOn && web.served;
      const servesOtherMachines = endpoint.servesOtherMachinesKey === undefined
        ? undefined
        : enabled && runtime.configManager.get(endpoint.servesOtherMachinesKey) === true;
      const binding = web?.binding ?? resolveRuntimeEndpointBinding(runtime.configManager, endpoint.id);
      const result: CliServiceEndpointPosture = {
        id: endpoint.id,
        label: endpoint.label,
        enabled,
        binding,
        bindPosture: classifyBindPosture(binding),
        networkFacing: web === undefined ? isNetworkFacing(servesOtherMachines ?? enabled, binding) : enabled && web.networkFacing,
        ...(servesOtherMachines === undefined ? {} : { servesOtherMachines }),
        ...(options.probe && enabled && binding.recognized && options.mayProbe(binding)
          ? { reachable: await options.probeTcp(binding.host, binding.port) }
          : {}),
      };
      options.assertCurrent();
      return result;
    }),
  );
  options.assertCurrent();
  return endpoints;
}

/**
 * One service finding as every report states it: what is wrong (summary), why,
 * what it costs, and the one command that fixes it. `status`, `doctor` and
 * `service status` in both terminal apps print these records as they are, so a
 * finding has one wording and one remedy wherever it shows.
 */
export interface ServiceFinding {
  readonly id: string;
  readonly summary: string;
  readonly cause: string;
  readonly impact: string;
  readonly action: string;
}

/** The endpoint findings: one that is on but does not answer, and two configured onto one address. */
export function serviceEndpointFindings(endpoints: readonly CliServiceEndpointPosture[], probe: boolean | undefined): ServiceFinding[] {
  const findings: ServiceFinding[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.enabled && probe && endpoint.reachable === false) {
      findings.push({
        id: `endpoint-unreachable-${endpoint.id}`,
        summary: `${endpoint.label} is enabled but not reachable on ${endpoint.binding.host}:${endpoint.binding.port}.`,
        cause: 'Nothing answered on that address when it was tried: the daemon is not running, or it could not bind the address.',
        impact: `Programs that connect to the ${endpoint.label} cannot reach it.`,
        action: 'Start the daemon: goodvibes-daemon start-service (its log says why a bind failed: goodvibes-daemon service-status)',
      });
    }
  }
  const enabled = endpoints.filter((endpoint) => endpoint.enabled);
  for (const [index, left] of enabled.entries()) {
    for (const right of enabled.slice(index + 1)) {
      // A served web UI is the control-plane listener itself, not a second bind.
      if ((left.id === 'web' && right.id === 'controlPlane') || (left.id === 'controlPlane' && right.id === 'web')) continue;
      const a = left.binding,
        b = right.binding;
      if (a.port === b.port && (a.host === b.host || a.host === '0.0.0.0' || b.host === '0.0.0.0' || a.host === '::' || b.host === '::')) {
        findings.push({
          id: `endpoint-conflict-${left.id}-${right.id}`,
          summary: `${left.label} and ${right.label} are configured to bind the same host/port envelope (${a.host}:${a.port}, ${b.host}:${b.port}).`,
          cause: 'Two endpoints are set to the same port on overlapping addresses.',
          impact: 'Only one of them can start; the other fails to bind.',
          action: `Give one of them another port: goodvibes-daemon config set ${right.id}.port <port>`,
        });
      }
    }
  }
  return findings;
}

/** The finding for a service log that exists but cannot be read. */
export function serviceLogUnreadableFinding(readError: string): ServiceFinding {
  return {
    id: 'service-log-unreadable',
    summary: `Service log exists but could not be read: ${readError}`,
    cause: 'The daemon service log exists but this user cannot read it.',
    impact: 'A failed start cannot be diagnosed from the log.',
    action: 'Check the file\'s owner and mode with ls -l on the path named above.',
  };
}

/** The endpoint findings' summaries, for a report that lists them as lines. */
export function serviceEndpointIssues(endpoints: readonly CliServiceEndpointPosture[], probe: boolean | undefined): string[] {
  return serviceEndpointFindings(endpoints, probe).map((finding) => finding.summary);
}

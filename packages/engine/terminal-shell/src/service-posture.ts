import { closeSync, existsSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { resolveRuntimeEndpointBinding, type RuntimeEndpointBinding, type RuntimeEndpointId } from './cli-endpoints.js';
import { classifyBindPosture, isNetworkFacing } from './cli-network-posture.js';
import { redactText } from './cli-redaction.js';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
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
    try {
      readSync(fd, raw, 0, length, Math.max(0, stat.size - length));
    } finally {
      closeSync(fd);
    }
    captured = { stat, text: raw.toString('utf-8') };
  } catch {
    return {
      path,
      exists: true,
      size: 0,
      modifiedAt: null,
      readError: 'Service log could not be read.',
    };
  }
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    const current = statSync(path);
    const original = captured.stat;
    if (
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      current.size !== original.size ||
      current.mtimeMs !== original.mtimeMs ||
      current.ctimeMs !== original.ctimeMs
    )
      throw new Error('Service log changed during redaction.');
  };
  let tail: string;
  try {
    tail = await decisionOrClassic(() => {
      captureOwner?.();
      return redactText(captured.text, { ...options, assertCurrent });
    }, () => redactText(captured.text, { ...options, assertCurrent }));
  } catch {
    // Withhold the captured bytes when redaction is unavailable. Revocation,
    // cancellation and a changed file still prevent the entire publication.
    assertCurrent();
    return { path, exists: true, size: captured.stat.size, modifiedAt: captured.stat.mtimeMs, readError: 'Service log could not be read safely.' };
  }
  assertCurrent();
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
    const result: unknown = callerCurrent?.();
    if (result !== undefined) {
      drainOwned(result);
      throw new Error('Service posture ownership must be synchronous.');
    }
    sourceCurrent();
  };
}

export async function readServiceEndpoints(
  runtime: CliServiceRuntime,
  definitions: readonly {
    readonly id: RuntimeEndpointId;
    readonly label: string;
    readonly enabledKey: Parameters<ConfigManager['get']>[0];
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
      const enabled = runtime.configManager.get(endpoint.enabledKey) === true;
      const binding = resolveRuntimeEndpointBinding(runtime.configManager, endpoint.id);
      const result: CliServiceEndpointPosture = {
        id: endpoint.id,
        label: endpoint.label,
        enabled,
        binding,
        bindPosture: classifyBindPosture(binding),
        networkFacing: isNetworkFacing(enabled, binding),
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

export function serviceEndpointIssues(endpoints: readonly CliServiceEndpointPosture[], probe: boolean | undefined): string[] {
  const issues: string[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.enabled && probe && endpoint.reachable === false)
      issues.push(`${endpoint.label} is enabled but not reachable on ${endpoint.binding.host}:${endpoint.binding.port}.`);
  }
  const enabled = endpoints.filter((endpoint) => endpoint.enabled);
  for (const [index, left] of enabled.entries()) {
    for (const right of enabled.slice(index + 1)) {
      const a = left.binding,
        b = right.binding;
      if (a.port === b.port && (a.host === b.host || a.host === '0.0.0.0' || b.host === '0.0.0.0' || a.host === '::' || b.host === '::')) {
        issues.push(
          `${left.label} and ${right.label} are configured to bind the same host/port envelope (${a.host}:${a.port}, ${b.host}:${b.port}).`,
        );
      }
    }
  }
  return issues;
}

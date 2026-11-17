/**
 * The live state a playbook's diagnostic checks read: the runtime store, the
 * time of the last runtime event (kept by one long-lived observer), the p95
 * turn-start, cancel and permission-decision latency (one SloCollector), the
 * approvals waiting on the owner, the session recovery files, the model's
 * context window and the plugin manager's view of plugins when this process
 * has them. A source this process does not have is absent, and a
 * check that needs it reports itself as not evaluated.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { RuntimeEventBus } from '../events/index.js';
import type { RuntimeStore } from '../store/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { SloCollector } from '../perf/slo-collector.js';
import type { PluginStatus } from '../../plugins/manager.js';

/** One measured latency: its p95 over the recent window and how many samples it rests on. */
export interface OpsLatencyReading {
  readonly p95Ms: number;
  readonly samples: number;
}

/** An approval waiting on the owner, as a check sees it. */
export interface OpsPendingApproval {
  readonly id: string;
  readonly tool: string;
  readonly createdAt: number;
}

export interface OpsCheckContext {
  readonly store: Pick<RuntimeStore, 'getState'>;
  readonly now: () => number;
  /** When the last runtime event was seen; undefined before the first. */
  readonly lastEventAt: () => number | undefined;
  /**
   * The measured p95 latency of an SLO metric (`slo.turn_start.p95`,
   * `slo.cancel.p95`, `slo.permission_decision.p95`); undefined while it has
   * no sample, or when this process does not measure it.
   */
  readonly latency?: ((metric: string) => OpsLatencyReading | undefined) | undefined;
  /** Approvals waiting on the owner, when this process holds the approval broker. */
  readonly pendingApprovals?: (() => readonly OpsPendingApproval[]) | undefined;
  /** The crash-recovery file of the open session, when this surface keeps one. */
  readonly recoveryFilePath?: (() => string | undefined) | undefined;
  /** The pointer to the last session this surface had open, when it has one. */
  readonly lastSessionPointerPath?: string | undefined;
  /** The context window of the model in use, in tokens, when this process selects models. */
  readonly contextWindow?: (() => number | undefined) | undefined;
  /** Every discovered plugin as the plugin manager sees it now, when this process runs plugins. */
  readonly plugins?: (() => readonly PluginStatus[]) | undefined;
}

/** The runtime event domains whose traffic counts as "the runtime is doing something". */
const OBSERVED_DOMAINS = [
  'session', 'turn', 'tools', 'tasks', 'agents', 'contracts', 'providers',
  'gate', 'compaction', 'plugins', 'mcp', 'transport', 'ops',
] as const;

/**
 * One observer per process, created where the services are composed: it only
 * remembers the time of the last event (one number written per event), so a
 * check can tell an idle runtime from a stalled one.
 */
export function createOpsEventObserver(runtimeBus: Pick<RuntimeEventBus, 'onDomain'>): {
  readonly lastEventAt: () => number | undefined;
  readonly dispose: () => void;
} {
  let last: number | undefined;
  const unsubscribes = OBSERVED_DOMAINS.map((domain) => runtimeBus.onDomain(domain, (envelope) => { last = envelope.ts; }));
  return {
    lastEventAt: () => last,
    dispose: () => { for (const unsubscribe of unsubscribes) unsubscribe(); },
  };
}

export interface OpsCheckContextOptions {
  readonly store: Pick<RuntimeStore, 'getState'>;
  readonly runtimeBus: Pick<RuntimeEventBus, 'onDomain'>;
  readonly listApprovals?: ((limit: number) => readonly { readonly id: string; readonly status: string; readonly createdAt: number; readonly request: { readonly tool: string } }[]) | undefined;
  readonly recoveryFilePath?: (() => string | undefined) | undefined;
  readonly lastSessionPointerPath?: string | undefined;
  readonly contextWindow?: (() => number | undefined) | undefined;
  readonly plugins?: (() => readonly PluginStatus[]) | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Build the check context once per process. Reading costs nothing until a
 * check runs; per event the context writes one number (the last event time)
 * and, for turn and gate events, at most one map entry and one sample.
 */
export function createOpsCheckContext(options: OpsCheckContextOptions): OpsCheckContext & { readonly dispose: () => void } {
  const observer = createOpsEventObserver(options.runtimeBus);
  const slo = new SloCollector(options.runtimeBus);
  const listApprovals = options.listApprovals;
  return {
    store: options.store,
    now: options.now ?? Date.now,
    lastEventAt: observer.lastEventAt,
    latency: (metric) => {
      const reading = slo.getMetrics().find((entry) => entry.name === metric);
      return reading ? { p95Ms: reading.value, samples: slo.getSampleCounts()[metric] ?? 0 } : undefined;
    },
    ...(listApprovals ? {
      pendingApprovals: () => listApprovals(Number.MAX_SAFE_INTEGER)
        .filter((approval) => approval.status === 'pending' || approval.status === 'claimed')
        .map((approval) => ({ id: approval.id, tool: approval.request.tool, createdAt: approval.createdAt }))
        .sort((a, b) => a.createdAt - b.createdAt),
    } : {}),
    ...(options.recoveryFilePath ? { recoveryFilePath: options.recoveryFilePath } : {}),
    ...(options.lastSessionPointerPath ? { lastSessionPointerPath: options.lastSessionPointerPath } : {}),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
    dispose: () => { observer.dispose(); slo.dispose(); },
  };
}

export function readRecoveryFileMetadata(path: string): { ok: boolean; summary: string } {
  if (!existsSync(path)) {
    return { ok: false, summary: 'Recovery file does not exist.' };
  }
  try {
    const [firstLine] = readFileSync(path, 'utf-8').split('\n');
    if (!firstLine) {
      return { ok: false, summary: 'Recovery file exists but is empty.' };
    }
    JSON.parse(firstLine);
    return { ok: true, summary: 'Recovery file exists and has valid metadata.' };
  } catch (error) {
    return {
      ok: false,
      summary: `Recovery file is not parseable: ${summarizeError(error)}`,
    };
  }
}

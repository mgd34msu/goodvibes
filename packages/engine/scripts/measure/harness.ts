/** Scenario shape and the measurement loop. Types only plus the loop; no product imports. */
import { fixtureTraffic, readKernelIo, resetCounters, resetFixtureTraffic, snapshotCounters, takeTrace, networkLog, type Counters, type KernelIo } from './instrument.ts';
import { decisionCounts, providerCounts, resetFakeCounts } from './fakes.ts';

export interface MeasureEnv {
  /** Isolated root for this scenario; HOME, XDG_* and TMPDIR all point inside it. */
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
}

export interface Instance {
  /** Unmeasured preparation before each run (run -1 is the warm-up). */
  prepare?(run: number): Promise<void> | void;
  /** The measured operation; may return scenario-specific counts. Checks that cost nothing (its own return value) belong here. */
  op(run: number): Promise<Record<string, number> | void>;
  /** Checks of the operation's outcome that read stores or files: run after the counters are taken, so they are not counted. */
  verify?(run: number): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface Scenario {
  readonly name: string;
  /** What exactly is driven. */
  readonly drives: string;
  /** file:line of the entry points driven. */
  readonly entries: readonly string[];
  /** Set when the scenario needs a capability the product never supplies outside tests. */
  readonly testOnly?: string;
  /** Measured runs after one warm-up (default 5). */
  readonly runs?: number;
  setup(env: MeasureEnv): Promise<Instance>;
}

export interface RunSample {
  readonly wallMs: number;
  readonly counters: Counters;
  readonly kernel: KernelIo;
  readonly decisionRequests: number;
  readonly decisionBytes: number;
  readonly providerRequests: number;
  readonly providerBytes: number;
  readonly extra: Record<string, number>;
  /** Operations of the kinds named in MEASURE_TRACE. */
  readonly trace: readonly string[];
}

export interface ScenarioReport {
  readonly name: string;
  readonly drives: string;
  readonly entries: readonly string[];
  readonly testOnly?: string;
  readonly runs: number;
  readonly wallMs: { readonly median: number; readonly min: number; readonly max: number; readonly samples: readonly number[] };
  /** Medians over the measured runs. */
  readonly median: Record<string, number>;
  /** Decision requests per battery/site in the last measured run. */
  readonly decisionSites: Record<string, number>;
  /** Decisions no fixture claimed in the last measured run (answered neutrally). */
  readonly unroutedDecisions: Record<string, number>;
  readonly networkRefused: readonly string[];
  readonly setupMs: number;
  /** With MEASURE_TRACE set: the traced operations of the last measured run. */
  readonly trace?: readonly string[];
  readonly error?: string;
}

/**
 * Thrown by a scenario whose operation did not do what it claims (a tool call
 * failed, a search found nothing it should have, a write did not land). The
 * scenario then reports this reason instead of numbers, and run.ts exits
 * non-zero, so a time is never reported for an operation that failed.
 */
export class ScenarioFailure extends Error {
  constructor(message: string) { super(message); this.name = 'ScenarioFailure'; }
}

/** Every scenario checks its own outcome with this after each run, the warm-up included. */
export function assertOutcome(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new ScenarioFailure(reason);
}

/** Work an operation starts but does not await (debounced saves, decision log records) is counted if it lands within this window. */
export const SETTLE_MS = 150;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

/** The kernel counters include this read of /proc/self/io; measured once and subtracted. */
function kernelBaseline(): KernelIo {
  const a = readKernelIo(); const b = readKernelIo();
  return { osReadCalls: b.osReadCalls - a.osReadCalls, osWriteCalls: b.osWriteCalls - a.osWriteCalls, osBytesRead: b.osBytesRead - a.osBytesRead, osBytesWritten: b.osBytesWritten - a.osBytesWritten };
}

async function measureOnce(instance: Instance, run: number, base: KernelIo): Promise<RunSample> {
  await instance.prepare?.(run);
  await settle();
  resetCounters(); resetFakeCounts(); resetFixtureTraffic();
  const k0 = readKernelIo();
  const t0 = performance.now();
  const extra = (await instance.op(run)) ?? {};
  const wallMs = performance.now() - t0;
  await settle();
  // Requests to an in-process fixture server standing in for a remote model service.
  if (fixtureTraffic.requests > 0) Object.assign(extra, { fixtureRequests: fixtureTraffic.requests, fixtureBytes: fixtureTraffic.bytes });
  const k1 = readKernelIo();
  const counted = snapshotCounters();
  const traced = takeTrace();
  const decisions = { requests: decisionCounts.requests, bytes: decisionCounts.bytes };
  const provider = { requests: providerCounts.requests, bytes: providerCounts.bytes };
  await instance.verify?.(run);
  return {
    wallMs,
    counters: counted,
    kernel: {
      osReadCalls: k1.osReadCalls - k0.osReadCalls - base.osReadCalls,
      osWriteCalls: k1.osWriteCalls - k0.osWriteCalls - base.osWriteCalls,
      osBytesRead: k1.osBytesRead - k0.osBytesRead - base.osBytesRead,
      osBytesWritten: k1.osBytesWritten - k0.osBytesWritten - base.osBytesWritten,
    },
    decisionRequests: decisions.requests,
    decisionBytes: decisions.bytes,
    providerRequests: provider.requests,
    providerBytes: provider.bytes,
    extra,
    trace: traced,
  };
}

export async function measure(scenario: Scenario, env: MeasureEnv): Promise<ScenarioReport> {
  const runs = scenario.runs ?? 5;
  const s0 = performance.now();
  const instance = await scenario.setup(env);
  const setupMs = performance.now() - s0;
  const base = kernelBaseline();
  const samples: RunSample[] = [];
  let decisionSites: Record<string, number> = {};
  let unroutedDecisions: Record<string, number> = {};
  try {
    await measureOnce(instance, -1, base);
    for (let run = 0; run < runs; run++) {
      samples.push(await measureOnce(instance, run, base));
      decisionSites = { ...decisionCounts.bySite };
      unroutedDecisions = { ...decisionCounts.unrouted };
    }
  } finally {
    await instance.dispose?.();
  }
  const flat = samples.map((sample) => ({
    ...sample.counters, ...sample.kernel,
    decisionRequests: sample.decisionRequests, decisionBytes: sample.decisionBytes,
    providerRequests: sample.providerRequests, providerBytes: sample.providerBytes,
    ...sample.extra,
  } as Record<string, number>));
  const keys = [...new Set(flat.flatMap((row) => Object.keys(row)))];
  const walls = samples.map((sample) => sample.wallMs);
  return {
    name: scenario.name, drives: scenario.drives, entries: scenario.entries,
    ...(scenario.testOnly ? { testOnly: scenario.testOnly } : {}),
    runs,
    wallMs: { median: median(walls), min: Math.min(...walls), max: Math.max(...walls), samples: walls },
    median: Object.fromEntries(keys.map((key) => [key, median(flat.map((row) => row[key] ?? 0))])),
    decisionSites, unroutedDecisions,
    networkRefused: [...new Set(networkLog)],
    setupMs,
    ...(samples.at(-1)?.trace.length ? { trace: samples.at(-1)!.trace } : {}),
  };
}

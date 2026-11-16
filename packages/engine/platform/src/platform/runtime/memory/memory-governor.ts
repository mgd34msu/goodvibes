/**
 * memory-governor.ts, the daemon's self-defense against unbounded memory
 * growth. It samples RSS + heap on an interval, maps the footprint to a tier
 * against a configured budget, and drives the CacheRegistry and PauseController
 * so the daemon sheds memory BEFORE the OS OOM-kills it (the ~100GB SIGTRAP
 * incident this exists to end).
 *
 * Tiers (percentages of the budget, owner-confirmed defaults):
 *   normal   (< elevatedPct) , nothing to do; resume any paused jobs.
 *   elevated (>= elevatedPct), trim registered caches to their floor + gc.
 *   high     (>= highPct)    , flush all registered caches + pause deferrable
 *                               background jobs.
 *   critical (>= criticalPct), everything `high` does, plus refuse new
 *                               expensive work with an honest structured outcome
 *                               and emit an ops attention event.
 *
 * Leak tripwire: if, AFTER a full flush, RSS keeps growing faster than
 * `tripwireRateMbPerSec` for `tripwireSustainSec` continuously, the flush did
 * not help, a genuine leak. The governor logs a diagnostic (top cache
 * footprints + heap stats), emits an ops attention event, writes a receipt, and
 * exits gracefully so a supervisor restarts clean, never a silent abort.
 *
 * Absolute-RSS backstop: the rate tripwire is blind to any leak SLOWER than
 * `tripwireRateMbPerSec`, such a leak would ride all the way to a kernel OOM
 * kill with no exit and no receipt. So a second, rate-independent ceiling is
 * anchored to the EFFECTIVE KILL CEILING (the own-cgroup memory limit where one
 * applies, else physical RAM, the line the kernel actually kills at): if RSS
 * holds at/above `hardLimitPct`% of that ceiling for `tripwireSustainSec`, the
 * governor takes the SAME graceful exit + receipt path (the receipt's `trigger`
 * is `hard-limit` and carries the tier history). Deliberately NOT anchored to
 * the budget: the default budget caps at 4096MB, and a large-but-stable working
 * set above the budget with plenty of host headroom is the critical tier's
 * stay-alive job, exiting there would put a healthy daemon in a restart loop.
 *
 * Everything I/O (sampler, clock, gc, exit, receipt write, ops emit) is
 * injected, so the tier machine and tripwire are unit-testable with fake clocks
 * and samplers.
 */
import { totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import type { CacheRegistry, CacheFootprint } from './cache-registry.js';
import type { PauseController } from './pause-controller.js';

/**
 * Effective system memory in MB: the smaller of physical RAM and the cgroup
 * memory limit that applies to THIS PROCESS. The process's own cgroup is
 * resolved from /proc/self/cgroup and every ancestor directory up to the
 * cgroup root is checked (the effective limit is the MINIMUM along the chain)
 *, a daemon run under systemd MemoryMax= has its limit at
 * /sys/fs/cgroup/system.slice/<unit>.service/memory.max, which a root-only
 * read misses entirely. Root-path reads remain as the final fallback (a
 * container with a private cgroup namespace reports `0::/`, which the walk
 * covers anyway). Without this, a limited daemon budgets off physical RAM and
 * every tier sits ABOVE the kernel kill line: the kernel OOM-kills it while
 * the governor still reports 'normal'.
 */
export function resolveEffectiveSystemRamMb(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  physicalRamMb: number = totalmem() / (1024 * 1024),
): number {
  const parseLimit = (raw: string): number | null => {
    const text = raw.trim();
    if (text === 'max') return null; // v2 unlimited
    const bytes = Number(text);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    const mb = bytes / (1024 * 1024);
    // v1 reports a huge sentinel (~PiB) when unlimited; ignore anything
    // implausibly larger than physical RAM.
    if (mb > physicalRamMb * 4) return null;
    return mb;
  };
  const tryRead = (path: string): number | null => {
    try {
      return parseLimit(readFile(path));
    } catch {
      return null; // absent, not limited at this level/version
    }
  };
  /** Ancestor chain of a cgroup path: '/system.slice/gv.service' -> ['', '/system.slice', '/system.slice/gv.service']. */
  const ancestorsOf = (cgroupPath: string): string[] => {
    const clean = cgroupPath === '/' ? '' : cgroupPath.replace(/\/$/, '');
    const parts = clean.split('/').filter(Boolean);
    const chain: string[] = [''];
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      chain.push(current);
    }
    return chain;
  };
  const limits: number[] = [];
  try {
    const selfCgroup = readFile('/proc/self/cgroup');
    for (const line of selfCgroup.split('\n')) {
      // v2 unified: '0::<path>'. v1 memory controller: '<n>:memory:<path>'.
      const v2 = /^0::(.*)$/.exec(line.trim());
      if (v2) {
        for (const dir of ancestorsOf(v2[1] ?? '/')) {
          const limit = tryRead(`/sys/fs/cgroup${dir}/memory.max`);
          if (limit !== null) limits.push(limit);
        }
        continue;
      }
      const v1 = /^\d+:memory:(.*)$/.exec(line.trim());
      if (v1) {
        for (const dir of ancestorsOf(v1[1] ?? '/')) {
          const limit = tryRead(`/sys/fs/cgroup/memory${dir}/memory.limit_in_bytes`);
          if (limit !== null) limits.push(limit);
        }
      }
    }
  } catch {
    // /proc/self/cgroup unreadable (non-Linux), fall through to root reads
  }
  // Root-path fallbacks (private-namespace containers; kept for compatibility).
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const limit = tryRead(path);
    if (limit !== null) limits.push(limit);
  }
  if (limits.length > 0) return Math.min(Math.min(...limits), physicalRamMb);
  return physicalRamMb;
}

export type MemoryTier = 'normal' | 'elevated' | 'high' | 'critical';

const TIER_RANK: Record<MemoryTier, number> = { normal: 0, elevated: 1, high: 2, critical: 3 };

/** One memory sample. Heap fields are best-effort (bun:jsc where available). */
export interface MemorySample {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes?: number | undefined;
}

export type MemorySampler = () => MemorySample;

/** Owner-confirmed governor configuration. */
export interface MemoryGovernorConfig {
  /** Budget in MB. 0 or negative ⇒ auto: min(25% of system RAM, 4096). */
  readonly budgetMb: number;
  readonly elevatedPct: number;
  readonly highPct: number;
  readonly criticalPct: number;
  readonly tripwireRateMbPerSec: number;
  readonly tripwireSustainSec: number;
  /**
   * Absolute-RSS backstop, as a percent of the EFFECTIVE KILL CEILING, the
   * own-cgroup memory limit where one applies, else physical RAM (default 90).
   * The backstop exists to beat the kernel/cgroup OOM killer, so it anchors to
   * the line the kernel actually kills at, NOT to the budget: the default
   * budget deliberately caps at 4096MB, and a large-but-stable working set
   * legitimately above the budget (mmap'd sqlite pages, a big heap graph,
   * not registered caches, not reclaimable by flush) is the critical tier's
   * job (refuse expensive work, stay alive), never an exit condition. When RSS
   * holds at/above hardLimitPct% of the ceiling for the tripwire sustain
   * window, the governor takes the SAME graceful exit + receipt path as the
   * rate tripwire, catching the slow leak the rate condition is blind to,
   * without false-firing on healthy hosts with room to spare.
   */
  readonly hardLimitPct?: number | undefined;
  /** Sampling cadence in ms (default 5000). */
  readonly sampleIntervalMs?: number | undefined;
}

/** The four settings whose relation decides whether the governor can run. */
export interface MemoryPolicyValues {
  readonly budgetMb: number;
  readonly elevatedPct: number;
  readonly highPct: number;
  readonly criticalPct: number;
  readonly hardLimitPct?: number | undefined;
}

/** Why a memory configuration cannot run, and which group of settings is at fault. */
export interface MemoryPolicyProblem {
  /** `tiers`: memory.tier.*; `hard-limit`: memory.hardLimitPct against memory.budgetMb and the critical tier. */
  readonly group: 'tiers' | 'hard-limit';
  readonly message: string;
}

/** The shipped values the governor falls back to for a group that cannot run. */
const SHIPPED_TIERS = { elevatedPct: 60, highPct: 80, criticalPct: 95 } as const;
const SHIPPED_HARD_LIMIT_PCT = 90;
/** The settings each group stands for, named in status when the group falls back. */
const POLICY_GROUP_SETTINGS: Readonly<Record<MemoryPolicyProblem['group'], readonly string[]>> = {
  tiers: ['memory.tier.elevatedPct', 'memory.tier.highPct', 'memory.tier.criticalPct'],
  'hard-limit': ['memory.budgetMb', 'memory.hardLimitPct'],
};

/** Options the composition hands the governor besides its configuration. */
export interface MemoryGovernorOptions {
  /**
   * Why the configured memory settings were refused as a whole before this
   * governor was built on the shipped ones; status and the ops event say so.
   */
  readonly configRefusal?: string | undefined;
}

/** The budget in MB a configured value resolves to: 0 or less is auto, min(25% of the ceiling, 4096), at least 256. */
export function resolveMemoryBudgetMb(budgetMb: number, ceilingMb: number): number {
  return budgetMb > 0 ? budgetMb : Math.max(256, Math.min(Math.floor(ceilingMb * 0.25), 4096));
}

/**
 * The one statement of what a valid memory configuration is: the tiers in
 * order (elevated < high < critical <= 100), the hard limit in (0, 100], and
 * the hard limit (a percent of the machine's kill ceiling) above the critical
 * tier (a percent of the budget). The settings writer refuses a change that
 * breaks it; the governor falls back for the group that breaks it. Pure:
 * `ceilingMb` is the caller's reading of the machine.
 */
export function validateMemoryPolicy(config: MemoryPolicyValues, ceilingMb: number): MemoryPolicyProblem | null {
  const { elevatedPct, highPct, criticalPct } = config;
  if (!(elevatedPct > 0 && elevatedPct < highPct && highPct < criticalPct && criticalPct <= 100)) {
    return {
      group: 'tiers',
      message: `memory.tier.elevatedPct (${elevatedPct}) < memory.tier.highPct (${highPct}) < memory.tier.criticalPct (${criticalPct}) must hold, each in (0, 100]; change the other tier first`,
    };
  }
  const hardLimitPct = config.hardLimitPct ?? SHIPPED_HARD_LIMIT_PCT;
  if (!(hardLimitPct > 0 && hardLimitPct <= 100)) {
    return { group: 'hard-limit', message: `memory.hardLimitPct (${hardLimitPct}) must be in (0, 100]; it is a percent of the memory this machine can use` };
  }
  const budgetMb = resolveMemoryBudgetMb(config.budgetMb, ceilingMb);
  const criticalMb = budgetMb * (criticalPct / 100);
  const hardLimitMb = ceilingMb * (hardLimitPct / 100);
  if (hardLimitMb > criticalMb) return null;
  return {
    group: 'hard-limit',
    message: `the critical tier (${Math.round(criticalMb)}MB = ${criticalPct}% of the ${budgetMb}MB memory.budgetMb) is at or above the hard limit `
      + `(${Math.round(hardLimitMb)}MB = ${hardLimitPct}% of the ${Math.round(ceilingMb)}MB this machine can use); lower memory.budgetMb or memory.tier.criticalPct, or raise memory.hardLimitPct`,
  };
}

/** Injectable collaborators (all default to real implementations). */
export interface MemoryGovernorDeps {
  readonly caches: CacheRegistry;
  readonly pauses: PauseController;
  readonly sampler?: MemorySampler | undefined;
  readonly now?: (() => number) | undefined;
  readonly gc?: (() => void) | undefined;
  readonly resolveSystemRamMb?: (() => number) | undefined;
  /** Emit the ops attention event (tier change to critical, tripwire). */
  readonly emitOps?: ((event: MemoryPressureEvent) => void) | undefined;
  /** Persist a tripwire receipt so a supervisor sees why the daemon exited. */
  readonly writeReceipt?: ((receipt: MemoryTripwireReceipt) => void) | undefined;
  /**
   * Graceful shutdown hook run BEFORE the tripwire exit, the daemon
   * composition wires the same work its signal handlers do (session/store
   * snapshots, inhibitor release). Bounded by a 10s ceiling so a wedged hook
   * cannot pin a leaking daemon alive.
   */
  readonly shutdown?: ((receipt: MemoryTripwireReceipt) => Promise<void> | void) | undefined;
  /** Perform the final exit (default process.exit(1)). Injected in tests. */
  readonly exit?: ((receipt: MemoryTripwireReceipt) => void) | undefined;
}

/** The ops attention event payload the governor hands to {@link MemoryGovernorDeps.emitOps}. */
export interface MemoryPressureEvent {
  readonly tier: MemoryTier;
  readonly previousTier: MemoryTier;
  readonly rssMb: number;
  readonly heapMb: number;
  readonly budgetMb: number;
  readonly usedPct: number;
  readonly tripwire?: { readonly rateMbPerSec: number; readonly sustainedSec: number; readonly action: 'exit' } | undefined;
  readonly note?: string | undefined;
}

/** One recorded tier transition, oldest-first, carried in the exit receipt. */
export interface MemoryTierTransition {
  readonly at: number;
  readonly tier: MemoryTier;
}

/** Written to disk when the governor exits under memory pressure. */
export interface MemoryTripwireReceipt {
  readonly kind: 'memory-leak-tripwire';
  /**
   * Which backstop fired: 'rate-tripwire', post-flush growth exceeded
   * tripwireRateMbPerSec for the sustain window (a FAST leak); 'hard-limit',
   * RSS held at/above hardLimitPct% of the effective kill ceiling (own-cgroup
   * limit or physical RAM) for the sustain window regardless of rate (a SLOW
   * leak the rate tripwire is structurally blind to, caught just before the
   * kernel/cgroup OOM killer would act).
   */
  readonly trigger: 'rate-tripwire' | 'hard-limit';
  readonly at: number;
  readonly rssMb: number;
  readonly budgetMb: number;
  readonly rateMbPerSec: number;
  readonly sustainedSec: number;
  readonly heap: MemorySample;
  readonly topCaches: readonly CacheFootprint[];
  /** Tier ladder history (oldest-first) so the receipt shows how RSS climbed. */
  readonly tierHistory: readonly MemoryTierTransition[];
  readonly note: string;
}

/** The ops.memory verb payload, the full governor snapshot. */
export interface MemoryGovernorSnapshot {
  readonly tier: MemoryTier;
  readonly budgetMb: number;
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb?: number;
  readonly usedPct: number;
  readonly refusingExpensiveWork: boolean;
  readonly caches: readonly CacheFootprint[];
  readonly pausedJobs: readonly string[];
  readonly tripwire: {
    readonly armed: boolean;
    readonly sustainedSec: number;
    /** The growth rate observed over the last sample window. */
    readonly rateMbPerSec: number;
    /** The configured growth rate a sustained leak must exceed to fire the tripwire. */
    readonly thresholdMbPerSec?: number;
  };
  readonly thresholds: {
    readonly elevatedPct: number;
    readonly highPct: number;
    readonly criticalPct: number;
  };
  /** The hard limit in force: RSS held at or above `mb` (`pct`% of the `ceilingMb` this machine can use) for the sustain window ends the daemon gracefully. */
  readonly hardLimit: {
    readonly pct: number;
    readonly mb: number;
    readonly ceilingMb: number;
  };
  /**
   * Present when configured memory settings were refused: which settings, and
   * why. The budget, thresholds and hard limit above are the ones in force (the
   * shipped values for the refused settings) until the setting is fixed and the
   * daemon restarts.
   */
  readonly configFallback?: {
    readonly settings: readonly string[];
    readonly reason: string;
  };
}

/** Structured refusal returned when the governor is at the critical tier. */
export interface ExpensiveWorkDecision {
  readonly allowed: boolean;
  readonly tier: MemoryTier;
  readonly reason?: string | undefined;
}

const MB = 1024 * 1024;

function defaultSampler(): MemorySample {
  const mem = process.memoryUsage();
  return { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal };
}

function defaultGc(): void {
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
  if (bun?.gc) bun.gc(true);
  else if (typeof globalThis.gc === 'function') (globalThis.gc as () => void)();
}

/**
 * A tier is left only once RSS is this many points of the budget below the
 * threshold that entered it, so an RSS sitting on a threshold does not flip
 * pause/resume and trim/collect on consecutive samples.
 */
export const TIER_RELEASE_MARGIN_PCT = 5;

export class MemoryGovernor {
  private readonly caches: CacheRegistry;
  private readonly pauses: PauseController;
  private readonly sampler: MemorySampler;
  private readonly now: () => number;
  private readonly gc: () => void;
  private readonly emitOps: ((event: MemoryPressureEvent) => void) | undefined;
  private readonly writeReceipt: ((receipt: MemoryTripwireReceipt) => void) | undefined;
  private readonly shutdown: ((receipt: MemoryTripwireReceipt) => Promise<void> | void) | undefined;
  private readonly exit: (receipt: MemoryTripwireReceipt) => void;
  private readonly sampleIntervalMs: number;

  private readonly budgetMb: number;
  private readonly effectiveCeilingMb: number;
  private readonly elevatedBytes: number;
  private readonly highBytes: number;
  private readonly criticalBytes: number;
  private readonly hardLimitBytes: number;
  private readonly hardLimitPct: number;
  private readonly tripwireRateBytesPerSec: number;
  private readonly tripwireSustainMs: number;

  private tier: MemoryTier = 'normal';
  private refusing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private exited = false;

  // Tier-ladder history (oldest-first, bounded) so an exit receipt shows how
  // RSS climbed through the tiers before the backstop fired.
  private tierHistory: MemoryTierTransition[] = [];
  // Absolute-RSS backstop: the first sample at/above the hard limit stamps this;
  // it clears the moment RSS drops back under. Fires once sustained.
  private hardLimitOverSince: number | null = null;

  // Tripwire state: armed after a full flush. The growth rate is computed over
  // a SLIDING window of recent samples (not a lifetime average since arming),
  // a daemon long-resident at high tier would otherwise dilute a genuine
  // late-onset leak below the threshold for hours.
  private tripwireArmed = false;
  private tripwireSamples: Array<{ at: number; rssBytes: number }> = [];
  private tripwireOverSince: number | null = null;
  private lastRateMbPerSec = 0;

  /** Why the configured values are not the ones running, when they are not. */
  private readonly policyFallback: string | undefined;
  /** The settings whose configured values are not running. */
  private readonly refusedSettings: readonly string[];

  constructor(configured: MemoryGovernorConfig, deps: MemoryGovernorDeps, options: MemoryGovernorOptions = {}) {
    this.caches = deps.caches;
    this.pauses = deps.pauses;
    this.pauses.setPressureProbe(() => (TIER_RANK[this.tier] >= TIER_RANK.high ? `memory-pressure:${this.tier}` : undefined));
    this.sampler = deps.sampler ?? defaultSampler;
    this.now = deps.now ?? Date.now;
    this.gc = deps.gc ?? defaultGc;
    this.emitOps = deps.emitOps;
    this.writeReceipt = deps.writeReceipt;
    this.shutdown = deps.shutdown;
    this.exit = deps.exit ?? ((): void => { process.exit(1); });
    this.sampleIntervalMs = Math.max(250, configured.sampleIntervalMs ?? 5_000);

    const resolveRam = deps.resolveSystemRamMb ?? resolveEffectiveSystemRamMb;
    // The effective kill ceiling: the smaller of the own-cgroup memory limit
    // (where one applies) and physical RAM, the line the kernel/cgroup OOM
    // killer actually enforces. Both the auto budget and the hard-limit
    // backstop anchor here.
    this.effectiveCeilingMb = resolveRam();
    // A configuration that cannot run (an older settings file, or one moved to
    // a smaller machine) does not stop the product starting: the offending
    // group falls back to the shipped values, and status and the ops event say so.
    let config = configured;
    const fallbacks: string[] = [];
    const refused = new Set<string>();
    if (options.configRefusal !== undefined) {
      fallbacks.push(options.configRefusal.replace(/[.\s]+$/, ''));
      for (const keys of Object.values(POLICY_GROUP_SETTINGS)) for (const key of keys) refused.add(key);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const problem = validateMemoryPolicy(config, this.effectiveCeilingMb);
      if (problem === null) break;
      fallbacks.push(problem.message);
      for (const key of POLICY_GROUP_SETTINGS[problem.group]) refused.add(key);
      config = problem.group === 'tiers'
        ? { ...config, ...SHIPPED_TIERS }
        : { ...config, budgetMb: 0, hardLimitPct: SHIPPED_HARD_LIMIT_PCT };
    }
    this.refusedSettings = [...refused];
    this.policyFallback = fallbacks.length > 0
      ? `The memory settings ${this.refusedSettings.join(', ')} could not run, so shipped values are in use for them: ${fallbacks.join('; ')}. `
        + 'Fix the setting; the change applies after the daemon restarts.'
      : undefined;
    if (this.policyFallback) logger.warn(this.policyFallback);
    const hardLimitPct = config.hardLimitPct ?? SHIPPED_HARD_LIMIT_PCT;
    this.budgetMb = resolveMemoryBudgetMb(config.budgetMb, this.effectiveCeilingMb);
    const budgetBytes = this.budgetMb * MB;
    this.elevatedBytes = budgetBytes * (config.elevatedPct / 100);
    this.highBytes = budgetBytes * (config.highPct / 100);
    this.criticalBytes = budgetBytes * (config.criticalPct / 100);
    this.hardLimitPct = hardLimitPct;
    // validateMemoryPolicy above keeps this ABOVE the critical tier, so the
    // backstop never fires before the critical tier's stay-alive posture.
    this.hardLimitBytes = this.effectiveCeilingMb * MB * (hardLimitPct / 100);
    this.tripwireRateBytesPerSec = config.tripwireRateMbPerSec * MB;
    this.tripwireSustainMs = config.tripwireSustainSec * 1000;
    if (this.policyFallback && this.emitOps) {
      const sample = this.sampler();
      this.emitOps({
        tier: 'normal', previousTier: 'normal', rssMb: round1(sample.rssBytes / MB), heapMb: round1(sample.heapUsedBytes / MB),
        budgetMb: this.budgetMb, usedPct: round1((sample.rssBytes / (this.budgetMb * MB)) * 100), note: this.policyFallback,
      });
    }
  }

  /** Begin interval sampling. Idempotent. The timer is unref'd so it never pins the loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sampleOnce(), this.sampleIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop sampling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The current tier. */
  currentTier(): MemoryTier {
    return this.tier;
  }

  /**
   * Consult the governor before starting expensive work. At the critical tier
   * the daemon refuses with an honest structured outcome rather than piling on
   * more allocation.
   */
  admitExpensiveWork(label = 'expensive operation'): ExpensiveWorkDecision {
    if (this.refusing) {
      return {
        allowed: false,
        tier: this.tier,
        reason: this.criticalRefusal(label),
      };
    }
    return { allowed: true, tier: this.tier };
  }

  /**
   * The critical-tier refusal: the state, the reason and what to change. The
   * caches this governor can shed hold little, so waiting rarely clears the
   * pressure; the budget setting or a restart does.
   */
  private criticalRefusal(label: string): string {
    const rssMb = Math.round(this.sampler().rssBytes / MB);
    const largest = [...this.caches.footprints()].sort((a, b) => b.entries - a.entries)[0];
    return `${label} refused: the daemon is at critical memory pressure (RSS ${rssMb}MB, at or above ${Math.round(this.criticalBytes / MB)}MB, `
      + `${round1((this.criticalBytes / (this.budgetMb * MB)) * 100)}% of the ${this.budgetMb}MB memory.budgetMb). `
      + (largest ? `The largest shed-able cache is ${largest.name} (${largest.entries} entries). ` : '')
      + 'Raise memory.budgetMb, or restart the daemon to release memory, then try again.';
  }

  /** The full governor snapshot served by the ops.memory verb. */
  snapshot(): MemoryGovernorSnapshot {
    const sample = this.sampler();
    const usedPct = (sample.rssBytes / (this.budgetMb * MB)) * 100;
    return {
      tier: this.tier,
      budgetMb: this.budgetMb,
      rssMb: round1(sample.rssBytes / MB),
      heapUsedMb: round1(sample.heapUsedBytes / MB),
      ...(sample.heapTotalBytes !== undefined ? { heapTotalMb: round1(sample.heapTotalBytes / MB) } : {}),
      usedPct: round1(usedPct),
      refusingExpensiveWork: this.refusing,
      caches: this.caches.footprints(),
      pausedJobs: this.pauses.pausedJobs(),
      tripwire: {
        armed: this.tripwireArmed,
        sustainedSec: this.tripwireOverSince !== null ? round1((this.now() - this.tripwireOverSince) / 1000) : 0,
        rateMbPerSec: round1(this.lastRateMbPerSec),
        thresholdMbPerSec: round1(this.tripwireRateBytesPerSec / MB),
      },
      thresholds: {
        elevatedPct: round1((this.elevatedBytes / (this.budgetMb * MB)) * 100),
        highPct: round1((this.highBytes / (this.budgetMb * MB)) * 100),
        criticalPct: round1((this.criticalBytes / (this.budgetMb * MB)) * 100),
      },
      hardLimit: { pct: this.hardLimitPct, mb: Math.round(this.hardLimitBytes / MB), ceilingMb: Math.round(this.effectiveCeilingMb) },
      ...(this.policyFallback !== undefined ? { configFallback: { settings: this.refusedSettings, reason: this.policyFallback } } : {}),
    };
  }

  /** Why the configured memory settings are not the ones running (shipped values replaced a group that could not run), or undefined. */
  policyFallbackReason(): string | undefined {
    return this.policyFallback;
  }

  /** Take one sample and apply tier actions + tripwire. Exposed for deterministic tests. */
  sampleOnce(): void {
    if (this.exited) return;
    const sample = this.sampler();
    const rss = sample.rssBytes;
    const nextTier = this.tierFor(rss);
    // Caches are shed once, on entering a tier: a repeated flush and forced
    // collection while RSS stays put costs a blocking full collection and the
    // reconnect replay, and cannot lower an RSS the shed-able caches do not hold.
    if (nextTier !== this.tier) {
      const previousTier = this.tier;
      this.tier = nextTier;
      this.recordTierTransition(nextTier);
      this.applyTier(nextTier, previousTier, sample);
    }
    this.checkTripwire(sample);
    this.checkHardLimit(sample);
  }

  /** Append a bounded tier-transition entry for the exit receipt's history. */
  private recordTierTransition(tier: MemoryTier): void {
    this.tierHistory.push({ at: this.now(), tier });
    // Bound the history so a long-lived daemon flapping tiers cannot grow it
    // unboundedly, the receipt only needs the recent climb.
    if (this.tierHistory.length > 32) this.tierHistory.shift();
  }

  /**
   * Absolute-RSS backstop anchored to the EFFECTIVE KILL CEILING (own-cgroup
   * limit or physical RAM), not the budget. The rate tripwire is structurally
   * blind to any leak slower than tripwireRateMbPerSec, so a slow leak would
   * ride all the way to a kernel OOM kill with no exit and no receipt; when
   * RSS holds at/above hardLimitPct% of the ceiling for the sustain window,
   * take the SAME graceful exit path the rate tripwire uses. A stable working
   * set above the BUDGET but below the ceiling never fires this, that is the
   * critical tier's stay-alive posture, not an exit condition.
   */
  private checkHardLimit(sample: MemorySample): void {
    if (this.exited) return;
    if (sample.rssBytes < this.hardLimitBytes) {
      this.hardLimitOverSince = null;
      return;
    }
    const now = this.now();
    if (this.hardLimitOverSince === null) this.hardLimitOverSince = now;
    if (now - this.hardLimitOverSince >= this.tripwireSustainMs) {
      this.fireExit(sample, 'hard-limit');
    }
  }

  /** The tier for this RSS: up at a threshold, down only below it by the release margin. */
  private tierFor(rssBytes: number): MemoryTier {
    const margin = this.budgetMb * MB * (TIER_RELEASE_MARGIN_PCT / 100);
    const current = TIER_RANK[this.tier];
    const at = (threshold: number, rank: number): boolean => rssBytes >= (current >= rank ? threshold - margin : threshold);
    if (at(this.criticalBytes, TIER_RANK.critical)) return 'critical';
    if (at(this.highBytes, TIER_RANK.high)) return 'high';
    if (at(this.elevatedBytes, TIER_RANK.elevated)) return 'elevated';
    return 'normal';
  }

  private applyTier(tier: MemoryTier, previousTier: MemoryTier, sample: MemorySample): void {
    const rank = TIER_RANK[tier];
    this.receipt('info', `memory tier ${previousTier} -> ${tier}`, {
      rssMb: round1(sample.rssBytes / MB),
      budgetMb: this.budgetMb,
    });

    if (rank >= TIER_RANK.elevated) {
      // Elevated: shrink to floor and reclaim.
      this.caches.trimAll('floor');
      this.gc();
    }
    if (rank >= TIER_RANK.high) {
      // High/critical: full flush + pause deferrable jobs, and arm the tripwire
      // against the post-flush baseline.
      this.caches.trimAll('flush');
      this.pauses.pauseAll(`memory-pressure:${tier}`);
      this.armTripwire(sample);
    } else {
      // Dropped below high: disarm the tripwire and resume jobs.
      this.disarmTripwire();
      this.pauses.resumeAll(`memory-recovered:${tier}`);
    }

    this.refusing = rank >= TIER_RANK.critical;

    if (rank >= TIER_RANK.critical || (previousTier !== tier && rank >= TIER_RANK.high)) {
      this.emitPressure(tier, previousTier, sample);
    }
  }

  private armTripwire(sample: MemorySample): void {
    // Arm once on the first flush; the sliding sample window starts here.
    if (!this.tripwireArmed) {
      this.tripwireArmed = true;
      this.tripwireSamples = [{ at: this.now(), rssBytes: sample.rssBytes }];
      this.tripwireOverSince = null;
    }
  }

  private disarmTripwire(): void {
    this.tripwireArmed = false;
    this.tripwireSamples = [];
    this.tripwireOverSince = null;
    this.lastRateMbPerSec = 0;
  }

  private checkTripwire(sample: MemorySample): void {
    if (!this.tripwireArmed) return;
    const now = this.now();
    this.tripwireSamples.push({ at: now, rssBytes: sample.rssBytes });
    // Sliding window: rate over the last sustain-window of samples. Evict
    // anything older than 2x the window so memory stays bounded and a long
    // residency at high tier cannot dilute a late-onset leak.
    const windowStart = now - this.tripwireSustainMs;
    while (this.tripwireSamples.length > 2 && this.tripwireSamples[1]!.at <= windowStart) {
      this.tripwireSamples.shift();
    }
    const oldest = this.tripwireSamples[0]!;
    const elapsedSec = (now - oldest.at) / 1000;
    if (elapsedSec <= 0) return;
    const rateBytesPerSec = (sample.rssBytes - oldest.rssBytes) / elapsedSec;
    this.lastRateMbPerSec = rateBytesPerSec / MB;
    if (rateBytesPerSec > this.tripwireRateBytesPerSec) {
      if (this.tripwireOverSince === null) this.tripwireOverSince = now;
      const sustainedMs = now - this.tripwireOverSince;
      if (sustainedMs >= this.tripwireSustainMs) {
        this.fireExit(sample, 'rate-tripwire');
      }
    } else {
      this.tripwireOverSince = null;
    }
  }

  private fireExit(sample: MemorySample, trigger: 'rate-tripwire' | 'hard-limit'): void {
    if (this.exited) return;
    this.exited = true;
    this.stop();
    const sustainedSec = trigger === 'hard-limit'
      ? (this.hardLimitOverSince !== null ? (this.now() - this.hardLimitOverSince) / 1000 : this.tripwireSustainMs / 1000)
      : (this.tripwireOverSince !== null ? (this.now() - this.tripwireOverSince) / 1000 : this.tripwireSustainMs / 1000);
    // From here on nothing may stop the exit below: the latch is already
    // set and the sampler stopped, so a throw would leave a leaking process
    // running with no governor. Diagnostics are best effort.
    let topCaches: MemoryTripwireReceipt['topCaches'] = [];
    try {
      topCaches = [...this.caches.footprints()]
        .sort((a, b) => (b.estimatedBytes ?? b.entries) - (a.estimatedBytes ?? a.entries))
        .slice(0, 5);
    } catch { /* a cache's footprint callback failed; the receipt omits caches */ }
    const note = trigger === 'hard-limit'
      ? `RSS held at/above the hard limit (${this.hardLimitPct}% of the ${Math.round(this.effectiveCeilingMb)}MB effective kill ceiling = ${Math.round(this.hardLimitBytes / MB)}MB), the kernel/cgroup OOM killer was imminent and the growth was too slow for the rate tripwire to see. Exiting so a supervisor restarts clean.`
      : 'RSS kept growing after a full cache flush, a genuine leak. Exiting so a supervisor restarts clean.';
    const receipt: MemoryTripwireReceipt = {
      kind: 'memory-leak-tripwire',
      trigger,
      at: this.now(),
      rssMb: round1(sample.rssBytes / MB),
      budgetMb: this.budgetMb,
      rateMbPerSec: round1(this.lastRateMbPerSec),
      sustainedSec: round1(sustainedSec),
      heap: sample,
      topCaches,
      tierHistory: [...this.tierHistory],
      note,
    };
    try {
      logger.error(`[memory] ${trigger} fired, shutting down for a clean restart`, {
        trigger,
        rssMb: receipt.rssMb,
        rateMbPerSec: receipt.rateMbPerSec,
        sustainedSec: receipt.sustainedSec,
        topCaches: topCaches.map((c) => ({ id: c.id, entries: c.entries, bytes: c.estimatedBytes })),
      });
    } catch { /* logging must not block the exit */ }
    try {
      this.emitPressure('critical', this.tier, sample, {
        rateMbPerSec: receipt.rateMbPerSec,
        sustainedSec: receipt.sustainedSec,
        action: 'exit',
      });
    } catch (error) {
      try { logger.warn('[memory] tripwire ops event failed', { error: String(error) }); } catch { /* best effort */ }
    }
    try {
      this.writeReceipt?.(receipt);
    } catch (error) {
      logger.warn('[memory] tripwire receipt write failed', { error: String(error) });
    }
    // GRACEFUL exit: run the composition's shutdown work (the same session/
    // store snapshot + inhibitor-release path the signal handlers use), give
    // async I/O (ops event delivery, log flush) a beat, THEN exit nonzero.
    // Bounded so a wedged shutdown hook cannot pin the leaking daemon alive.
    void (async (): Promise<void> => {
      try {
        await Promise.race([
          Promise.resolve(this.shutdown?.(receipt)),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 10_000);
            (t as unknown as { unref?: () => void }).unref?.();
          }),
        ]);
      } catch (error) {
        logger.warn('[memory] tripwire shutdown hook failed', { error: String(error) });
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 100);
        (t as unknown as { unref?: () => void }).unref?.();
      });
      this.exit(receipt);
    })();
  }

  private emitPressure(
    tier: MemoryTier,
    previousTier: MemoryTier,
    sample: MemorySample,
    tripwire?: { rateMbPerSec: number; sustainedSec: number; action: 'exit' },
  ): void {
    this.emitOps?.({
      tier,
      previousTier,
      rssMb: round1(sample.rssBytes / MB),
      heapMb: round1(sample.heapUsedBytes / MB),
      budgetMb: this.budgetMb,
      usedPct: round1((sample.rssBytes / (this.budgetMb * MB)) * 100),
      ...(tripwire ? { tripwire } : {}),
    });
  }

  private receipt(level: 'info' | 'warn', message: string, fields: Record<string, unknown>): void {
    if (level === 'warn') logger.warn(`[memory] ${message}`, fields);
    else logger.info(`[memory] ${message}`, fields);
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

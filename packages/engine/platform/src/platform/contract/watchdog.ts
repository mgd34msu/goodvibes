/**
 * The silence watchdog over unit agents (docs/design/contract-runner.md
 * section 4.10).
 *
 * It keeps a last-seen time per agent from the agent events (running,
 * progress, stream deltas, and the terminal three).
 * When `contract.heartbeatTimeoutMs` is above zero, a timer at a quarter of
 * the timeout (between 50 ms and 5 s) looks for unit agents that are running,
 * not held, and silent past the timeout, and hands each to the runner, which
 * retries the unit once and fails it the second time.
 *
 * A tick that arrives far later than its interval means the process was not
 * running (a suspended laptop, a stopped container, a clock step), not that the
 * agents went quiet. That gap is never counted as silence: every agent's clock
 * restarts at the first tick after it.
 *
 * Time an agent spends held at its completion point is not silence: the
 * runner's check is what it waits on. Releasing a hold restarts the clock.
 * Elapsed time is arithmetic, so all of this is code.
 */
import type { AgentEvent } from '../../events/agents.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

/** A unit agent the watchdog may time: the runner lists them on each tick. */
export interface WatchedAgent {
  readonly contractId: string;
  readonly unitId: string;
  readonly agentId: string;
  /** When the agent was spawned; the clock starts here when no event was seen. */
  readonly startedAt: number;
}

export interface UnitWatchdogDeps {
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  /** `contract.heartbeatTimeoutMs`, read on each (re)start; 0 or less turns the watchdog off. */
  readonly timeoutMs: () => number;
  /** The unit agents that are running now and not held. */
  readonly watched: () => readonly WatchedAgent[];
  /** Called once per silent agent per tick; the runner retries or fails the unit. */
  readonly onSilent: (agent: WatchedAgent, silentMs: number) => void;
  readonly now?: (() => number) | undefined;
}

export interface UnitWatchdog {
  /** The clock restarts for an agent: a hold released, or a fresh agent spawned. */
  touch(agentId: string): void;
  /** Forgets an agent (terminal, or replaced). */
  forget(agentId: string): void;
  /** Runs one check now (tests; the timer calls the same). */
  tick(): void;
  /** Restarts the timer with the current timeout setting. */
  restart(): void;
  /** How many agents have a clock running (tests; the map must not grow with unrelated agents). */
  trackedAgents(): number;
  dispose(): void;
}

/** The check interval for a timeout: a quarter of it, at least 50 ms and at most 5 s. */
export function watchdogIntervalMs(timeoutMs: number): number {
  return Math.min(5_000, Math.max(50, Math.floor(timeoutMs / 4)));
}

const SEEN_EVENTS = ['AGENT_RUNNING', 'AGENT_PROGRESS', 'AGENT_STREAM_DELTA'] as const;
const TERMINAL_EVENTS = ['AGENT_COMPLETED', 'AGENT_FAILED', 'AGENT_CANCELLED'] as const;

/** A gap between ticks of more than this many intervals is the process having been stopped. */
const STALLED_TICK_INTERVALS = 3;

export function createUnitWatchdog(deps: UnitWatchdogDeps): UnitWatchdog {
  const now = deps.now ?? Date.now;
  const lastSeen = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTickAt = now();
  /** Silence is measured from here at the earliest: the last time a stalled process woke up. */
  let clockFloor = Number.NEGATIVE_INFINITY;

  // Only agents the runner touched (spawned units) keep a clock: the bus carries
  // every agent in the process, and an unrelated one must not grow this map.
  const unsubscribers = [
    ...SEEN_EVENTS.map((type) =>
      deps.runtimeBus.on<Extract<AgentEvent, { type: typeof type }>>(type, ({ payload }) => {
        if (lastSeen.has(payload.agentId)) lastSeen.set(payload.agentId, now());
      }),
    ),
    ...TERMINAL_EVENTS.map((type) =>
      deps.runtimeBus.on<Extract<AgentEvent, { type: typeof type }>>(type, ({ payload }) => {
        lastSeen.delete(payload.agentId);
      }),
    ),
  ];

  function tick(): void {
    const timeoutMs = deps.timeoutMs();
    const at = now();
    const sincePreviousTick = at - lastTickAt;
    lastTickAt = at;
    if (timeoutMs <= 0) return;
    if (sincePreviousTick > STALLED_TICK_INTERVALS * watchdogIntervalMs(timeoutMs) || sincePreviousTick < 0) {
      clockFloor = at;
      return;
    }
    for (const agent of deps.watched()) {
      const silentMs = at - Math.max(lastSeen.get(agent.agentId) ?? agent.startedAt, clockFloor);
      if (silentMs >= timeoutMs) deps.onSilent(agent, silentMs);
    }
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function restart(): void {
    stop();
    lastTickAt = now();
    const timeoutMs = deps.timeoutMs();
    if (timeoutMs <= 0) return;
    timer = setInterval(tick, watchdogIntervalMs(timeoutMs));
    timer.unref?.();
  }

  restart();
  return {
    touch: (agentId) => { lastSeen.set(agentId, now()); },
    forget: (agentId) => { lastSeen.delete(agentId); },
    tick,
    restart,
    trackedAgents: () => lastSeen.size,
    dispose: () => {
      stop();
      for (const unsubscribe of unsubscribers) unsubscribe();
      lastSeen.clear();
    },
  };
}

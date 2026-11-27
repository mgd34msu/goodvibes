/**
 * When each step's agent was last heard from, for the step's row ("quiet since ...").
 *
 * No clock acts on it: a step is never stopped, run again or failed for being quiet. A step ends when something
 * happens: its agent's turn ends, its process exits, its connection closes, the provider answers an error, or the
 * owner or a decision stops it. A quiet step keeps running and its row offers the work's stop.
 *
 * Only agents the runner touched (spawned steps) are followed: the bus carries every agent in the process.
 */
import type { AgentEvent } from '../../events/agents.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

export interface UnitActivityDeps {
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  /** The step's agent was heard from at `at` (epoch ms): the runner records it on the step. */
  readonly heard: (agentId: string, at: number) => void;
  readonly now?: (() => number) | undefined;
}

export interface UnitActivity {
  /** A step's agent started (or its hold was released): heard from now, and followed from here on. */
  touch(agentId: string): void;
  /** Stops following an agent (ended, or replaced). */
  forget(agentId: string): void;
  dispose(): void;
}

const HEARD_EVENTS = ['AGENT_RUNNING', 'AGENT_PROGRESS', 'AGENT_STREAM_DELTA'] as const;
const TERMINAL_EVENTS = ['AGENT_COMPLETED', 'AGENT_FAILED', 'AGENT_CANCELLED'] as const;

export function createUnitActivity(deps: UnitActivityDeps): UnitActivity {
  const now = deps.now ?? Date.now;
  const followed = new Set<string>();
  const unsubscribers = [
    ...HEARD_EVENTS.map((type) =>
      deps.runtimeBus.on<Extract<AgentEvent, { type: typeof type }>>(type, ({ payload }) => {
        if (followed.has(payload.agentId)) deps.heard(payload.agentId, now());
      }),
    ),
    ...TERMINAL_EVENTS.map((type) =>
      deps.runtimeBus.on<Extract<AgentEvent, { type: typeof type }>>(type, ({ payload }) => {
        followed.delete(payload.agentId);
      }),
    ),
  ];
  return {
    touch: (agentId) => {
      followed.add(agentId);
      deps.heard(agentId, now());
    },
    forget: (agentId) => { followed.delete(agentId); },
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      followed.clear();
    },
  };
}

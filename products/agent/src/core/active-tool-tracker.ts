/**
 * active-tool-tracker.ts, the tool call main is running right now, for the
 * throbber (renderer/throbber.ts): its name, its arguments (from
 * TOOL_RECEIVED) and when it started (TOOL_EXECUTING). A call leaves when it
 * succeeds, fails or is cancelled. With several calls running at once the
 * oldest is named and the others are counted, the same as the TUI.
 *
 * Bounded: the argument map keeps at most 64 entries, oldest dropped first,
 * so a turn whose calls never report back cannot grow it without limit.
 */

import type { UiRuntimeEvents } from '@/runtime/index.ts';

const MAX_TRACKED = 64;

export interface ActiveToolCall {
  readonly name: string;
  readonly args?: Record<string, unknown>;
  readonly startedAtMs?: number;
  /** Other calls running at the same time as this one. */
  readonly alsoRunning?: number;
}

export interface ActiveToolTracker {
  /** The running call to name (the oldest), with how many others run, or null when none runs. */
  current(): ActiveToolCall | null;
  /** Forget every call (a turn ended). */
  clear(): void;
  readonly unsubs: ReadonlyArray<() => void>;
}

export function trackActiveTool(tools: Pick<UiRuntimeEvents['tools'], 'on'>): ActiveToolTracker {
  const args = new Map<string, Record<string, unknown>>();
  const running = new Map<string, ActiveToolCall>();
  const bound = <V>(map: Map<string, V>): void => {
    while (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
  };
  const settle = (callId: string): void => {
    args.delete(callId);
    running.delete(callId);
  };
  const unsubs = [
    tools.on('TOOL_RECEIVED', (ev) => { args.set(ev.callId, ev.args ?? {}); bound(args); }),
    tools.on('TOOL_EXECUTING', (ev) => {
      running.delete(ev.callId); // re-inserted last: the map stays in start order
      running.set(ev.callId, { name: ev.tool, args: args.get(ev.callId), startedAtMs: ev.startedAt });
      bound(running);
    }),
    tools.on('TOOL_SUCCEEDED', (ev) => settle(ev.callId)),
    tools.on('TOOL_FAILED', (ev) => settle(ev.callId)),
    tools.on('TOOL_CANCELLED', (ev) => settle(ev.callId)),
  ];
  return {
    current: () => {
      for (const call of running.values()) return running.size > 1 ? { ...call, alsoRunning: running.size - 1 } : call;
      return null;
    },
    clear: () => { args.clear(); running.clear(); },
    unsubs,
  };
}

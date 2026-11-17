/**
 * Collapse policy, the one rule that decides "this is a repeat": a group is
 * every notification with the same domain, level and title, and it lasts one
 * fixed window counted from its first member (not from the last one, so a
 * steady trickle cannot keep a group open for ever). The first few members of
 * a window are shown; the rest are counted into the group's history entry.
 */

import type { Notification } from '../types.js';

/** Default collapse window in milliseconds. */
const DEFAULT_WINDOW_MS = 2_000;

/** Default number of members of one group shown on screen inside a window. */
const DEFAULT_SHOWN_PER_WINDOW = 3;

/** Groups kept before the expired ones are swept, so distinct titles cannot grow the map without bound. */
const SWEEP_AT_GROUPS = 256;

interface CollapseGroup {
  /** Timestamp of the group's first member: the window runs from here. */
  readonly windowStart: number;
  /** Members seen in this window, the current one included. */
  count: number;
  /** The key handed to consumers for this window's group. */
  readonly batchKey: string;
}

/** Where a notification falls in its collapse group. */
export interface CollapsePlacement {
  /** The group's key for this window; one history entry per key. */
  readonly batchKey: string;
  /** 1 for the first member of the window, 2 for the second, and so on. */
  readonly position: number;
  /** Whether this member is past the number shown on screen per window. */
  readonly collapsed: boolean;
}

export class BatchPolicy {
  private readonly groups = new Map<string, CollapseGroup>();
  private windowMs: number;
  private readonly shownPerWindow: number;

  constructor(windowMs: number = DEFAULT_WINDOW_MS, shownPerWindow: number = DEFAULT_SHOWN_PER_WINDOW) {
    this.windowMs = validWindow(windowMs);
    this.shownPerWindow = Number.isFinite(shownPerWindow) ? Math.max(1, Math.floor(shownPerWindow)) : DEFAULT_SHOWN_PER_WINDOW;
  }

  /** Change the window length; groups already open keep the window they started with. */
  setWindowMs(windowMs: number): void {
    this.windowMs = validWindow(windowMs);
  }

  /** Place a notification in its group, using its own timestamp as the clock. */
  evaluate(notification: Notification): CollapsePlacement {
    const groupKey = `${notification.domain}:${notification.level}:${notification.title}`;
    const now = notification.timestamp;
    let group = this.groups.get(groupKey);
    if (!group || now - group.windowStart >= this.windowMs) {
      if (!group && this.groups.size >= SWEEP_AT_GROUPS) this.sweep(now);
      group = { windowStart: now, count: 0, batchKey: `${groupKey}@${now}` };
      this.groups.set(groupKey, group);
    }
    group.count += 1;
    return { batchKey: group.batchKey, position: group.count, collapsed: group.count > this.shownPerWindow };
  }

  private sweep(now: number): void {
    for (const [key, group] of this.groups) {
      if (now - group.windowStart >= this.windowMs) this.groups.delete(key);
    }
  }
}

function validWindow(ms: number): number {
  return Math.max(1, Number.isFinite(ms) ? ms : DEFAULT_WINDOW_MS);
}

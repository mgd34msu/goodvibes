/**
 * ActivityFeed, the single ambient record of what the assistant has been doing.
 *
 * The sink for operational traffic (model switches, provider discovery, delivery results,
 * background work updates). The Activity modal renders the most recent
 * entries; high-priority messages additionally land in the conversation via
 * SystemMessageRouter.
 *
 * Design rules:
 * - Append-only ring buffer (oldest entries dropped past MAX_ENTRIES).
 * - No focus, no selection, no scrolling state, this is a glanceable feed,
 *   not an interactive widget. History beyond the visible window is available
 *   through the conversation (high priority) and logs.
 * - Subscribers are render invalidators only; they receive no payload.
 * - The writer states the kind: the system-message router passes the kind its
 *   writer declared (runtime event, contract kind, leading `[Tag]`); a direct
 *   caller passes its own or gets the same tag table. Nothing is read by a
 *   model, so an entry is complete the moment it is pushed.
 */
import { activityKindFor, type SystemMessageActivity } from '@goodvibes-jev/engine/terminal-shell/system-message-router';

/**
 * status (runtime/system state), tool, agent (background agent/delegation),
 * schedule (scheduled/automation work), delivery (channel deliveries),
 * security (permission/trust events), system (everything else).
 */
export type ActivityKind = SystemMessageActivity;

export type ActivityPriority = 'high' | 'low';

export interface ActivityEntry {
  readonly at: number;
  readonly kind: ActivityKind;
  readonly priority: ActivityPriority;
  readonly text: string;
}

const MAX_ENTRIES = 500;

export class ActivityFeed {
  private entries: ActivityEntry[] = [];
  private listeners = new Set<() => void>();

  push(text: string, priority: ActivityPriority = 'low', kind?: ActivityKind): void {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    this.entries.push({
      at: Date.now(),
      kind: kind ?? activityKindFor(trimmed),
      priority,
      text: trimmed,
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.notify();
  }

  /** Most recent entries, newest first. */
  latest(limit: number): readonly ActivityEntry[] {
    if (limit <= 0) return [];
    return this.entries.slice(-limit).reverse();
  }

  all(): readonly ActivityEntry[] {
    return this.entries;
  }

  get count(): number {
    return this.entries.length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Render invalidators must never break the feed.
      }
    }
  }
}

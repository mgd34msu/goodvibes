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
 * - The writer states the kind: an explicit `kind`, or the leading `[Tag]` the
 *   writer gave the line. Nothing is read by a model, so an entry is complete
 *   the moment it is pushed.
 */

export type ActivityKind =
  | 'status'     // runtime/system state changes (model switch, session save)
  | 'tool'       // tool activity worth surfacing
  | 'agent'      // background agent/delegation updates
  | 'schedule'   // scheduled/automation work
  | 'delivery'   // channel deliveries (ntfy, Slack, …)
  | 'security'   // permission/trust events
  | 'system';    // everything else

export type ActivityPriority = 'high' | 'low';

export interface ActivityEntry {
  readonly at: number;
  readonly kind: ActivityKind;
  readonly priority: ActivityPriority;
  readonly text: string;
}

const MAX_ENTRIES = 500;

/**
 * The activity kind of each leading `[Tag]` the products and the platform write,
 * keyed by the tag in lower case. An untagged line or an unlisted tag is 'system'.
 */
const TAG_ACTIVITY_KINDS: Readonly<Record<string, ActivityKind>> = {
  agents: 'agent', agent: 'agent', 'delegated task': 'agent', wrfc: 'agent', contract: 'agent', replay: 'agent',
  schedule: 'schedule', schedules: 'schedule', wake: 'schedule', calendar: 'schedule', reminder: 'schedule',
  'occasion reminder': 'schedule', automation: 'schedule', routine: 'schedule', routines: 'schedule',
  delivery: 'delivery', channel: 'delivery', channels: 'delivery', telegram: 'delivery', slack: 'delivery',
  discord: 'delivery', ntfy: 'delivery', email: 'delivery', push: 'delivery', webhook: 'delivery',
  approval: 'security', permission: 'security', permissions: 'security', security: 'security',
  trust: 'security', auth: 'security', pairing: 'security',
  tool: 'tool', 'tool recovery': 'tool', exec: 'tool', shell: 'tool', mcp: 'tool', plugin: 'tool', hook: 'tool',
  model: 'status', provider: 'status', providers: 'status', local: 'status', scan: 'status', session: 'status',
  resume: 'status', recovery: 'status', compaction: 'status', daemon: 'status', 'connected host': 'status',
  remote: 'status', bridge: 'status', startup: 'status', setup: 'status', install: 'status', update: 'status',
  workspace: 'status', memory: 'status', health: 'status', status: 'status', terminal: 'status',
  voice: 'status', stop: 'status', rewind: 'status', revert: 'status',
};

function activityKindOf(text: string): ActivityKind {
  if (!text.startsWith('[')) return 'system';
  const end = text.indexOf(']');
  if (end <= 1) return 'system';
  const tag = text.slice(1, end).toLowerCase();
  return Object.hasOwn(TAG_ACTIVITY_KINDS, tag) ? TAG_ACTIVITY_KINDS[tag]! : 'system';
}

export class ActivityFeed {
  private entries: ActivityEntry[] = [];
  private listeners = new Set<() => void>();

  push(text: string, priority: ActivityPriority = 'low', kind?: ActivityKind): void {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    this.entries.push({
      at: Date.now(),
      kind: kind ?? activityKindOf(trimmed),
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

/**
 * calendar-lists.ts, the live lists the calendar capabilities choose from
 * (platform capabilities/builtin/messages.ts, calendar.ts): the events ahead
 * (`calendar.events`, through `calendar.upcoming`) and the feeds subscribed to
 * (`calendar.subscriptions`, through `calendar.subscriptions`), both the
 * daemon's. Each terminal program gives the binding it reaches the daemon with;
 * the web UI reads the same rows from the methods named below.
 */
import { CALENDAR_EVENTS_LIST, CALENDAR_FEEDS_LIST } from '@goodvibes/engine/platform/platform/capabilities';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';

let bindingOf: DaemonCapabilityBinding<CommandActionContext> | undefined;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const records = (value: unknown, key: string): readonly Readonly<Record<string, unknown>>[] => {
  const list = isRecord(value) ? value[key] : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The events of the next 60 days, the list an event input chooses from. */
export const CALENDAR_EVENTS = defineList<CommandActionContext>({
  name: CALENDAR_EVENTS_LIST,
  async read(ctx) {
    if (!bindingOf) return [];
    const answer = await runDaemonCapability('calendar.upcoming', { days: '60' }, ctx, bindingOf);
    return records(answer.data, 'events').map((event): ListRow => ({
      value: text(event['id']), label: text(event['title']) || 'Untitled event', ...(text(event['start']) ? { detail: text(event['start']) } : {}),
    }));
  },
  operator: { method: 'calendar.events.list', input: {}, rows: { from: 'events', value: 'id', label: 'title', detail: 'start' } },
});

/** The calendar feeds subscribed to. */
export const CALENDAR_FEEDS = defineList<CommandActionContext>({
  name: CALENDAR_FEEDS_LIST,
  async read(ctx) {
    if (!bindingOf) return [];
    const answer = await runDaemonCapability('calendar.subscriptions', {}, ctx, bindingOf);
    return records(answer.data, 'feeds').map((feed): ListRow => ({ value: text(feed['name']), label: text(feed['name']), ...(text(feed['site']) ? { detail: text(feed['site']) } : {}) }));
  },
  operator: { method: 'capabilities.run', input: { id: 'calendar.subscriptions' }, rows: { from: 'data.feeds', value: 'name', label: 'name', detail: 'site' } },
});

/** Give the lists the binding this program reaches the daemon with. */
export function registerCalendarLists<Ctx extends CommandActionContext>(binding: DaemonCapabilityBinding<Ctx>): void {
  bindingOf = binding as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

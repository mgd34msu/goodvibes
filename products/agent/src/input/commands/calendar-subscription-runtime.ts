import {
  CalendarSubscriptionRegistry,
  createHttpFeedFetcher,
  type SubscribedOccurrence,
  type SubscriptionStatus,
  type SubscriptionSecretStore,
} from '../../agent/calendar-subscription-registry.ts';
import type { FeedFetcher } from '@goodvibes-jev/engine/platform/platform/calendar';
import type { CommandContext } from '../command-registry.ts';
import type { CalendarSubscription } from '@goodvibes-jev/engine/terminal-shell/calendar-command';
import type { ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { requireShellPaths } from './runtime-services.ts';
import { getSessionUntrustedContentLedger } from '../../trust/untrusted-content.ts';
import { commandRefusal } from './confirmation.ts';

/**
 * The calendar-feed actions of /calendar (terminal-shell/calendar-command.ts), the no-OAuth read path.
 * Subscriptions are iCalendar feeds (Google secret address, Outlook
 * published .ics, or any .ics URL). The parse/RRULE/fetch-status engine is the
 * platform's platform/calendar; this file is the /calendar command surface over the
 * agent-side CalendarSubscriptionRegistry.
 *
 * A feed URL is secrets-adjacent (a Google secret address grants read access),
 * so it is only ever stored through the secret manager and shown masked; the
 * subscribe verb refuses to run without a secret manager present.
 */


/** A no-op secret store for the read-only merged view, where no secret is ever read. */
const READ_ONLY_SECRET_STUB: SubscriptionSecretStore = {
  get: async () => null,
  set: async () => { throw new Error('read-only'); },
};

function secretStoreFrom(ctx: CommandContext): SubscriptionSecretStore | null {
  const sm = ctx.platform.secretsManager;
  if (!sm) return null;
  return sm as unknown as SubscriptionSecretStore;
}

/**
 * Build a registry for a WRITE/network verb, requires a secret manager. Returns
 * null (and the caller prints the honest reason) when none is available.
 */
export function subscriptionRegistryForWrite(ctx: CommandContext, fetcher?: FeedFetcher): CalendarSubscriptionRegistry | null {
  const secrets = secretStoreFrom(ctx);
  if (!secrets) return null;
  return CalendarSubscriptionRegistry.create(requireShellPaths(ctx), secrets, fetcher);
}

/**
 * Build a registry for the READ-ONLY merged view, tolerant of a missing secret
 * manager.
 *
 * This is where the untrusted-content ledger is bound, and it is bound HERE
 * rather than inside the registry for the same reason `buildEmailService` binds
 * it in email-runtime.ts: the registry then holds no ledger of its own, and a
 * test can observe every recording by handing it a recorder of its own.
 *
 * Only the READ builder gets one. `subscriptionRegistryForWrite` above serves
 * subscribe/unsubscribe/refresh, arrival, not a turn read, and wiring a
 * recorder there would let a timer-driven fetch arm the outward-effect guard for
 * whatever turn happened to be open. See the registry's class header.
 */
export function subscriptionRegistryForRead(ctx: CommandContext): CalendarSubscriptionRegistry {
  const secrets = secretStoreFrom(ctx) ?? READ_ONLY_SECRET_STUB;
  const ledger = getSessionUntrustedContentLedger();
  return CalendarSubscriptionRegistry.create(
    requireShellPaths(ctx),
    secrets,
    createHttpFeedFetcher(),
    // Reading a subscribed feed's event text arms the outward-effect guard the
    // same way reading mail or loading a page does. This assignment is what
    // type-checks the platform recorder's `'calendar-event'` literal against
    // UntrustedSurface.
    (ingest) => { ledger.record(ingest); },
  );
}

function formatHealth(s: SubscriptionStatus): string {
  const base = `${s.health}`;
  return s.detail ? `${base}, ${s.detail}` : base;
}

/** Render the subscribed-events section merged into /calendar list & upcoming. */
export function renderSubscribedSection(occurrences: readonly SubscribedOccurrence[]): string {
  if (occurrences.length === 0) return '';
  const lines = occurrences.map((o) => {
    const when = o.allDay ? o.start : o.start.slice(0, 16).replace('T', ' ');
    const loc = o.location ? `  at ${o.location}` : '';
    if (o.repeatsNotShown) {
      return `  [${o.subscription}] repeats since ${when}, dates not shown (the feed's repeat rule is not supported)  ${o.title}${loc}  (read-only)`;
    }
    const marker = o.recurrenceNotFullyExpanded ? '  [recurrence not fully expanded]' : '';
    return `  [${o.subscription}] ${when}  ${o.title}${loc}${marker}  (read-only)`;
  });
  return [`Subscribed calendar events (${occurrences.length})`, ...lines].join('\n');
}

function requireRegistry(ctx: CommandContext, fetcher: FeedFetcher | undefined, action: string): CalendarSubscriptionRegistry | null {
  const registry = subscriptionRegistryForWrite(ctx, fetcher);
  if (!registry) {
    throw commandRefusal(`Cannot ${action}: no secret manager is available in this runtime, and feed URLs are stored only as secrets.`);
  }
  return registry;
}

/** Subscribe to a feed: it is read once to check it, then kept and read on each refresh. */
export async function subscribeCalendarFeed(ctx: CommandContext, subscription: CalendarSubscription, fetcher?: FeedFetcher): Promise<string> {
  const refreshIntervalMs = subscription.everyMinutes !== undefined ? subscription.everyMinutes * 60_000 : undefined;
  // Feeds are fetched from public hosts only; a calendar server on the owner's own network needs this opt-in, per feed.
  const hostOptions = subscription.privateNetwork ? { allowPrivateHost: true } : {};
  const registry = requireRegistry(ctx, fetcher, 'subscribe');
  if (!registry) throw commandRefusal('Nothing was subscribed.');
  const result = await registry.subscribe(subscription.url, subscription.name, refreshIntervalMs, hostOptions);
  if (!result.ok) {
    throw commandRefusal([`Could not subscribe (${result.stage}); nothing was stored.`, `  ${result.detail}`].join('\n'), undefined, 'COMMAND_FAILED');
  }
  return [
    `Subscribed to '${result.name}'.`,
    `  events   ${result.eventCount} loaded`,
    `  refresh  every ${Math.round(result.refreshIntervalMs / 60_000)} min, /calendar refresh reads it now`,
    ...(subscription.privateNetwork ? ['  Private-network addresses are allowed for this feed.'] : []),
    '  These events are read-only and appear source-labeled in /calendar all and /calendar upcoming.',
  ].join('\n');
}

export async function unsubscribeCalendarFeed(ctx: CommandContext, name: string, fetcher?: FeedFetcher): Promise<string> {
  const registry = requireRegistry(ctx, fetcher, 'unsubscribe');
  if (!registry) throw commandRefusal('Nothing was removed.');
  const report = await registry.unsubscribeWithReport(name);
  if (!report.removed) throw commandRefusal(`No subscription named '${name}'.`, '/calendar subscriptions lists them');
  // The feed URL is a read capability for the whole calendar, so a copy the secret store would not delete is named, not hidden.
  if (report.secret === 'failed') {
    return [
      `Unsubscribed from '${name}', but its stored feed URL could not be deleted: ${report.secretError ?? 'the secret store refused'}.`,
      `  The feed URL is still in the secret store under ${report.secretKey}; remove that key by hand.`,
    ].join('\n');
  }
  return `Unsubscribed from '${name}'.`;
}

export async function calendarFeeds(ctx: CommandContext, fetcher?: FeedFetcher): Promise<string> {
  const registry = subscriptionRegistryForWrite(ctx, fetcher) ?? subscriptionRegistryForRead(ctx);
  const statuses = await registry.statuses();
  if (statuses.length === 0) return ['Calendar subscriptions', '  None. Add one with /calendar subscribe.'].join('\n');
  return [
    `Calendar subscriptions (${statuses.length})`,
    ...statuses.map((s) => [
      `  ${s.name}`,
      `    url     ${s.maskedUrl}`,
      `    status  ${formatHealth(s)}`,
      `    events  ${s.eventCount}`,
      `    refresh every ${Math.round(s.refreshIntervalMs / 60_000)} min${s.allowPrivateHost ? ' (private-network address allowed)' : ''}`,
    ].join('\n')),
  ].join('\n');
}

/** The feeds as rows for a choice (value: the feed's name). */
export async function calendarFeedRows(ctx: CommandContext): Promise<readonly ListRow[]> {
  const statuses = await (subscriptionRegistryForWrite(ctx) ?? subscriptionRegistryForRead(ctx)).statuses();
  return statuses.map((s) => ({ value: s.name, label: s.name, detail: s.maskedUrl, state: s.health }));
}

export async function refreshCalendarFeeds(ctx: CommandContext, name: string, fetcher?: FeedFetcher): Promise<string> {
  const registry = requireRegistry(ctx, fetcher, 'refresh subscriptions');
  if (!registry) throw commandRefusal('Nothing was read.');
  if (!registry.hasAny()) return 'No calendar subscriptions to refresh. Add one with /calendar subscribe.';
  const outcomes = await registry.refresh(name || undefined, { force: true });
  if (outcomes.length === 0) return name ? `No subscription named '${name}'.` : 'No calendar subscriptions to refresh.';
  return [
    `Refreshed ${outcomes.length} subscription${outcomes.length === 1 ? '' : 's'}`,
    ...outcomes.map((o) => {
      const detail = o.detail ? `, ${o.detail}` : '';
      const count = o.eventCount !== undefined ? ` (${o.eventCount} events)` : '';
      return `  ${o.name}: ${o.outcome}${count}${detail}`;
    }),
  ].join('\n');
}

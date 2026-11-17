import {
  CalendarSubscriptionRegistry,
  createHttpFeedFetcher,
  type SubscribedOccurrence,
  type SubscriptionStatus,
  type SubscriptionSecretStore,
} from '../../agent/calendar-subscription-registry.ts';
import type { FeedFetcher } from '@goodvibes-jev/engine/platform/platform/calendar';
import type { CommandContext } from '../command-registry.ts';
import { parseAgentLocalLibraryArgs } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';
import { getSessionUntrustedContentLedger } from '../../trust/untrusted-content.ts';
import { commandRefusal } from './confirmation.ts';

/**
 * External-calendar SUBSCRIPTION verbs for /calendar, the no-OAuth read path.
 * Subscriptions are iCalendar feeds (Google secret address, Outlook
 * published .ics, or any .ics URL). The parse/RRULE/fetch-status engine is the
 * platform's platform/calendar; this file is the /calendar command surface over the
 * agent-side CalendarSubscriptionRegistry.
 *
 * A feed URL is secrets-adjacent (a Google secret address grants read access),
 * so it is only ever stored through the secret manager and shown masked; the
 * subscribe verb refuses to run without a secret manager present.
 */

const SUBSCRIPTION_VALUE_FLAGS = ['name', 'every'] as const;
export const CALENDAR_SUBSCRIPTION_VERBS = new Set(['subscribe', 'unsubscribe', 'subscriptions', 'subs', 'refresh']);

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

function parseArgs(args: readonly string[]) {
  return parseAgentLocalLibraryArgs(args, { valueFlags: SUBSCRIPTION_VALUE_FLAGS });
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

/**
 * Handle a subscription verb. Returns true if it handled the sub-command (so the
 * caller's local-store path is skipped).
 */
export async function runCalendarSubscriptionCommand(
  sub: string,
  args: readonly string[],
  ctx: CommandContext,
  /** Injectable for tests, production callers pass undefined and get the real HTTP fetcher. */
  fetcher?: FeedFetcher,
): Promise<boolean> {
  if (!CALENDAR_SUBSCRIPTION_VERBS.has(sub)) return false;

  if (sub === 'subscribe') {
    await handleSubscribe(args, ctx, fetcher);
    return true;
  }
  if (sub === 'unsubscribe') {
    await handleUnsubscribe(args, ctx, fetcher);
    return true;
  }
  if (sub === 'subscriptions' || sub === 'subs') {
    await handleList(ctx, fetcher);
    return true;
  }
  if (sub === 'refresh') {
    await handleRefresh(args, ctx, fetcher);
    return true;
  }
  return false;
}

function requireRegistry(ctx: CommandContext, fetcher: FeedFetcher | undefined, action: string): CalendarSubscriptionRegistry | null {
  const registry = subscriptionRegistryForWrite(ctx, fetcher);
  if (!registry) {
    throw commandRefusal(`Cannot ${action}: no secret manager is available in this runtime, and feed URLs are stored only as secrets.`);
  }
  return registry;
}

async function handleSubscribe(args: readonly string[], ctx: CommandContext, fetcher?: FeedFetcher): Promise<void> {
  const parsed = parseArgs(args);
  const url = parsed.rest[0] ?? parsed.flags.get('url');
  if (!url) {
    throw commandRefusal('Usage: /calendar subscribe <ics-url> [--name <name>] [--every <minutes>] [--allow-private-host] [--yes]');
  }
  const requestedName = parsed.flags.get('name')?.trim() || undefined;
  const everyMin = parsed.flags.has('every') ? Math.max(15, parseInt(parsed.flags.get('every') ?? '', 10) || 60) : undefined;
  const refreshIntervalMs = everyMin !== undefined ? everyMin * 60_000 : undefined;

  // Feeds are fetched from public hosts only; a calendar server on the owner's own network needs this opt-in, per feed.
  const allowPrivateHost = parsed.flags.has('allow-private-host') || undefined;
  const hostOptions = allowPrivateHost ? { allowPrivateHost } : {};

  const registry = requireRegistry(ctx, fetcher, 'subscribe');
  if (!registry) return;

  // Consent-at-add preview: validate by fetching and state exactly what will be
  // fetched and how often, before anything is saved.
  if (!parsed.yes) {
    const check = await registry.validate(url, requestedName, hostOptions);
    if (!check.ok) {
      throw commandRefusal([`Subscription preview failed at the ${check.stage} stage.`, `  ${check.detail}`].join('\n'));
    }
    const intervalMin = Math.round((refreshIntervalMs ?? 60 * 60_000) / 60_000);
    ctx.print([
      'Calendar subscription preview',
      `  calendar ${check.calendarName ?? '(unnamed feed)'}`,
      `  name     ${check.derivedName}`,
      `  events   ${check.eventCount} found`,
      `  refresh  every ${intervalMin} min (read-only; the feed URL is stored as a secret)`,
      '  This will fetch the calendar from the URL you provided, now and on each refresh.',
      ...(allowPrivateHost ? ['  Private-network addresses are allowed for this feed (--allow-private-host).'] : []),
      '  rerun with --yes to subscribe',
    ].join('\n'));
    return;
  }

  const result = await registry.subscribe(url, requestedName, refreshIntervalMs, hostOptions);
  if (!result.ok) {
    ctx.print([`Could not subscribe (${result.stage}).`, `  ${result.detail}`].join('\n'));
    return;
  }
  const intervalMin = Math.round(result.refreshIntervalMs / 60_000);
  ctx.print([
    `Subscribed to '${result.name}'.`,
    `  events   ${result.eventCount} loaded`,
    `  refresh  every ${intervalMin} min, run /calendar refresh to update now`,
    '  These events are read-only and appear source-labeled in /calendar list.',
  ].join('\n'));
}

async function handleUnsubscribe(args: readonly string[], ctx: CommandContext, fetcher?: FeedFetcher): Promise<void> {
  const parsed = parseArgs(args);
  const name = parsed.rest.join(' ').trim() || parsed.flags.get('name')?.trim();
  if (!name) {
    throw commandRefusal('Usage: /calendar unsubscribe <name> [--yes]');
  }
  const registry = requireRegistry(ctx, fetcher, 'unsubscribe');
  if (!registry) return;
  if (!parsed.yes) {
    ctx.print([`Unsubscribe preview`, `  name ${name}`, '  This removes the subscription, its cached events, and its stored feed URL.', '  rerun with --yes to unsubscribe'].join('\n'));
    return;
  }
  const report = await registry.unsubscribeWithReport(name);
  if (!report.removed) {
    throw commandRefusal(`No subscription named '${name}'.`);
  }
  // The feed URL is a read capability for the whole calendar, so a copy the secret store would not delete is named, not hidden.
  if (report.secret === 'failed') {
    ctx.print([
      `Unsubscribed from '${name}', but its stored feed URL could not be deleted: ${report.secretError ?? 'the secret store refused'}.`,
      `  The feed URL is still in the secret store under ${report.secretKey}; remove that key by hand.`,
    ].join('\n'));
    return;
  }
  ctx.print(`Unsubscribed from '${name}'.`);
}

async function handleList(ctx: CommandContext, fetcher?: FeedFetcher): Promise<void> {
  const registry = subscriptionRegistryForWrite(ctx, fetcher) ?? subscriptionRegistryForRead(ctx);
  const statuses = await registry.statuses();
  if (statuses.length === 0) {
    ctx.print(['Calendar subscriptions', '  None. Add one with /calendar subscribe <ics-url> --yes'].join('\n'));
    return;
  }
  ctx.print([
    `Calendar subscriptions (${statuses.length})`,
    ...statuses.map((s) => [
      `  ${s.name}`,
      `    url     ${s.maskedUrl}`,
      `    status  ${formatHealth(s)}`,
      `    events  ${s.eventCount}`,
      `    refresh every ${Math.round(s.refreshIntervalMs / 60_000)} min${s.allowPrivateHost ? ' (private-network address allowed)' : ''}`,
    ].join('\n')),
  ].join('\n'));
}

async function handleRefresh(args: readonly string[], ctx: CommandContext, fetcher?: FeedFetcher): Promise<void> {
  const parsed = parseArgs(args);
  const name = parsed.rest.join(' ').trim() || undefined;
  const registry = requireRegistry(ctx, fetcher, 'refresh subscriptions');
  if (!registry) return;
  if (!registry.hasAny()) {
    ctx.print('No calendar subscriptions to refresh. Add one with /calendar subscribe <ics-url> --yes');
    return;
  }
  const outcomes = await registry.refresh(name, { force: true });
  if (outcomes.length === 0) {
    ctx.print(name ? `No subscription named '${name}'.` : 'No calendar subscriptions to refresh.');
    return;
  }
  ctx.print([
    `Refreshed ${outcomes.length} subscription${outcomes.length === 1 ? '' : 's'}`,
    ...outcomes.map((o) => {
      const detail = o.detail ? `, ${o.detail}` : '';
      const count = o.eventCount !== undefined ? ` (${o.eventCount} events)` : '';
      return `  ${o.name}: ${o.outcome}${count}${detail}`;
    }),
  ].join('\n'));
}

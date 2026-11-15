/**
 * Private Slack Web API intake prerequisite. Nothing registers this adapter.
 * The host must supply HTTP and a mapper that admits digest/previews under the
 * InboundChannelItem privacy contract. This module does not redact text, and
 * shape validation does not establish that the host's privacy work is correct.
 * Source/repairs: docs/contracts/daemon-inbox-and-triage.md#slack-complete-history-window.
 */
import type { AdapterContext, InboundChannelItem, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../provider-adapter.js';
import { POLL_CADENCE_MS } from '../provider-adapter.js';

const PROVIDER = 'slack';
const CREDENTIAL_KEY = 'surfaces.slack.botToken';
const MAX_LIST_PAGES = 50;
const MAX_HISTORY_PAGES = 20;
const MAX_TOTAL_HISTORY_PAGES = 200;
const MAX_ITEMS = 1_000;
/** A poll with no cursor starts this far back, so a long-lived account is not paged from its first message. */
const SEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
/** Window scans one poll may make while narrowing past a page budget or crossing empty windows. */
const MAX_WINDOW_SCANS = 8;
const MIN_WINDOW_MS = 2_000;

/**
 * Resolves only after response decoding and resource cleanup. The host owns
 * transport timeouts/body-byte bounds and cancellation; the adapter awaits it.
 */
export type SlackInboxHttp = (url: URL, request: {
  method: 'GET';
  headers: { Authorization: string; Accept: 'application/json' };
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; body: unknown }>;

/** Private, raw mapper input. It must never be logged or forwarded unchanged. */
export interface SlackInboxMappingInput {
  readonly senderId: string;
  readonly channelId: string;
  readonly subject: 'Direct message';
  readonly text: string;
}

/**
 * An explicit host admission decision. fromDigest is the first 16 hex
 * characters of SHA-256 of senderId; previews must satisfy
 * InboundChannelItem. No normalization helper alone implements this contract.
 * Returning null/undefined withholds the poll rather than silently skipping it.
 */
export interface SlackInboxMappedFields {
  readonly fromDigest: string;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
}
export type SlackInboxMapper = (input: SlackInboxMappingInput, signal?: AbortSignal) =>
  SlackInboxMappedFields | null | undefined | Promise<SlackInboxMappedFields | null | undefined>;

export interface SlackInboxPorts {
  readonly http: SlackInboxHttp;
  readonly mapItem: SlackInboxMapper;
  /** Unix milliseconds, captured once before any asynchronous work. */
  readonly now?: () => number;
}

interface Candidate {
  key: string;
  channelId: string;
  senderId: string;
  text: string;
  ts: string;
  receivedAt: number;
  kind: InboundChannelItem['kind'];
}

/** Only adapter-created, closed diagnostics may reach its result. */
const diagnostics = new WeakMap<object, string>();
function fail(message: string): never {
  const error = new Error(message);
  diagnostics.set(error, message);
  throw error;
}
function diagnostic(error: unknown): string | undefined {
  // WeakMap identity lookup never inspects an external rejection value. Even
  // instanceof can execute a throwing Proxy getPrototypeOf trap.
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? diagnostics.get(error) : undefined;
}
function checkActive(signal?: AbortSignal): void {
  if (signal?.aborted) fail('Slack poll cancelled');
}
function unavailable(error: string, configured?: boolean): ProviderPollResult {
  return { items: [], state: 'unavailable', error, ...(configured === undefined ? {} : { configured }) };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Slack response shape invalid');
  return value as Record<string, unknown>;
}
function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) fail('Slack response shape invalid');
  return value;
}
function identifier(value: unknown): string {
  const result = optionalString(value, 200);
  if (!result) fail('Slack response identifier missing');
  return result;
}
function nextCursor(response: Record<string, unknown>): string | undefined {
  if (response.response_metadata === undefined) return undefined;
  const cursor = record(response.response_metadata).next_cursor;
  return cursor === null ? undefined : optionalString(cursor, 4_096) || undefined;
}
function rows(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Slack response page invalid');
  return value;
}
function timestamp(value: unknown): { ts: string; receivedAt: number } {
  // Slack's timestamp grammar, not a reading of message meaning. Parse decimal
  // components rather than accepting parseFloat's trailing garbage/exponents.
  if (typeof value !== 'string' || !/^\d{1,13}\.\d{6}$/.test(value)) fail('Slack message timestamp invalid');
  const [seconds, micros] = value.split('.');
  const receivedAt = Number(seconds) * 1_000 + Math.round(Number(micros) / 1_000);
  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) fail('Slack message timestamp invalid');
  return { ts: value, receivedAt };
}
function classify(message: Record<string, unknown>, self: string, text: string, ts: string): Candidate['kind'] {
  if (message.reactions !== undefined && !Array.isArray(message.reactions)) fail('Slack response shape invalid');
  const thread = optionalString(message.thread_ts, 40);
  if (message.user === self && Array.isArray(message.reactions) && message.reactions.length > 0) return 'reaction';
  if (text.includes(`<@${self}>`)) return 'mention';
  return thread && thread !== ts ? 'thread' : 'dm';
}
function compare(a: Candidate, b: Candidate): number {
  return a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Private factory: no global fetch, implicit mapper, registration or public barrel. */
export function createSlackInboxAdapter(ctx: AdapterContext, ports: SlackInboxPorts): InboundProviderAdapter {
  // Reject omission before any credential/HTTP work, including untyped callers.
  if (typeof ports?.http !== 'function' || typeof ports?.mapItem !== 'function') {
    throw new Error('Slack inbox requires HTTP and an explicit item mapper');
  }
  return {
    id: PROVIDER,
    pollIntervalMs: POLL_CADENCE_MS.realtime,
    async poll(opts: ProviderPollOptions): Promise<ProviderPollResult> {
      let configured: boolean | undefined;
      let stage = 'Slack poll failed';
      let signal: AbortSignal | undefined;
      try {
        // Options can be supplied by hosts with accessors. Capture them once
        // inside the boundary; never reread them while handling a failure.
        signal = opts.signal;
        const { limit, since } = opts;
        checkActive(signal);
        const cutoff = Math.floor((ports.now ?? Date.now)());
        if (!Number.isSafeInteger(cutoff) || cutoff <= 0 || !Number.isSafeInteger(limit)
          || limit < 1 || limit > MAX_ITEMS || (since !== undefined
            && (!Number.isSafeInteger(since) || since < 0))) fail('Slack poll bounds invalid');
        stage = 'Slack credential lookup failed';
        const token = await ctx.credentials.resolveConfigSecret(CREDENTIAL_KEY);
        checkActive(signal);
        if (!token || !token.trim()) return unavailable('missing surfaces.slack.botToken', false);
        if (!token.startsWith('xoxb-') && !token.startsWith('xoxp-')) {
          return unavailable('surfaces.slack.botToken is not a Slack bot/user token', false);
        }
        configured = true;
        const get = async (method: 'auth.test' | 'conversations.list' | 'conversations.history', params: Record<string, string>) => {
          checkActive(signal);
          stage = `Slack ${method} request failed`;
          const url = new URL(`https://slack.com/api/${method}`);
          for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
          const response = await ports.http(url, {
            method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            ...(signal === undefined ? {} : { signal }),
          });
          checkActive(signal);
          if (!response.ok) fail(`Slack ${method} HTTP failure`);
          stage = `Slack ${method} response unreadable`;
          const body = record(response.body);
          if (body.ok !== true) fail(`Slack ${method} refused`);
          return body;
        };
        // Unknown self identity would silently turn mentions/reactions into DMs.
        const self = identifier((await get('auth.test', {})).user_id);
        const channels = new Map<string, string | undefined>();
        let cursor: string | undefined;
        const listCursors = new Set<string>();
        for (let page = 0; ; page += 1) {
          if (page >= MAX_LIST_PAGES) fail('Slack conversation page budget exhausted');
          const list = await get('conversations.list', { types: 'im', limit: '100', ...(cursor ? { cursor } : {}) });
          for (const entry of rows(list.channels, 100)) {
            const channel = record(entry);
            channels.set(identifier(channel.id), optionalString(channel.user, 200));
          }
          cursor = nextCursor(list);
          if (!cursor) break;
          if (listCursors.has(cursor)) fail('Slack conversation cursor repeated');
          listCursors.add(cursor);
        }
        // Keep only the oldest limit+1 distinct candidates. A window is scanned
        // completely before the poller's single global timestamp may pass it.
        // One request budget for the whole poll, however many windows it tries.
        let totalHistoryPages = 0;
        // A conversation read completely stays valid for any narrower window, so a rescan only re-reads the
        // conversation that overflowed. A truncated read (more than limit+1 candidates) kept only the oldest ones, so
        // it also serves a later floor only while the new upper bound stays at or below its newest kept candidate.
        const complete = new Map<string, { floor: number; upper: number; truncated: boolean; items: Candidate[] }>();
        // Where the overflowing conversation's newest pages ended: everything at or after it is already known to be
        // dense, so the next window can end there instead of searching blindly.
        let overflowReachedMs: number | undefined;
        const scan = async (floor: number, upper: number): Promise<Candidate[] | undefined> => {
          const found: Candidate[] = [];
          for (const [channelId, channelUser] of channels) {
            const cached = complete.get(channelId);
            if (cached && cached.floor <= floor && upper <= cached.upper
              && (!cached.truncated || cached.floor === floor || upper <= (cached.items[cached.items.length - 1]?.receivedAt ?? 0))) {
              for (const candidate of cached.items) {
                if (candidate.receivedAt >= upper || candidate.receivedAt <= floor || found.some(other => other.key === candidate.key)) continue;
                found.push(candidate); found.sort(compare);
                if (found.length > limit + 1) found.pop();
              }
              continue;
            }
            const own: Candidate[] = [];
            let truncated = false;
            let oldestSeenMs = Number.POSITIVE_INFINITY;
            let historyCursor: string | undefined;
            const historyCursors = new Set<string>();
            for (let page = 0; ; page += 1) {
              if (totalHistoryPages >= MAX_TOTAL_HISTORY_PAGES) fail('Slack history page budget exhausted');
              // A conversation too busy for this window is narrowed by the caller; a window is never committed partially.
              if (page >= MAX_HISTORY_PAGES) {
                overflowReachedMs = Number.isFinite(oldestSeenMs) ? oldestSeenMs : undefined;
                return undefined;
              }
              totalHistoryPages += 1;
              const history = await get('conversations.history', {
                channel: channelId, limit: '50', latest: (upper / 1_000).toFixed(6),
                oldest: (floor / 1_000).toFixed(6),
                ...(historyCursor ? { cursor: historyCursor } : {}),
              });
              if (history.is_limited === true) fail('Slack history is limited');
              if (history.is_limited !== undefined && typeof history.is_limited !== 'boolean') fail('Slack response shape invalid');
              for (const entry of rows(history.messages, 50)) {
                const message = record(entry);
                const subtype = optionalString(message.subtype, 200);
                const bot = optionalString(message.bot_id, 200);
                if (subtype === 'bot_message' || bot) {
                  // Skipped rows still count toward the pages read, so they still tell where the pages ended.
                  try { oldestSeenMs = Math.min(oldestSeenMs, timestamp(message.ts).receivedAt); } catch { /* An unreadable skipped row only loses the hint. */ }
                  continue;
                }
                const { ts, receivedAt } = timestamp(message.ts);
                oldestSeenMs = Math.min(oldestSeenMs, receivedAt);
                // Exclude the upper bound's entire rounded-ms bucket. A later poll
                // will see it whole, including arrivals during this scan.
                if (receivedAt <= floor || receivedAt >= upper) continue;
                const text = optionalString(message.text, 40_000) ?? '';
                const senderId = optionalString(message.user, 200) || channelUser || channelId;
                const key = `${channelId}:${ts}`;
                if (found.some(candidate => candidate.key === key)) continue;
                const candidate = { key, channelId, senderId, text, ts, receivedAt, kind: classify(message, self, text, ts) };
                found.push(candidate); found.sort(compare);
                if (found.length > limit + 1) found.pop();
                own.push(candidate); own.sort(compare);
                if (own.length > limit + 1) { own.pop(); truncated = true; }
              }
              historyCursor = nextCursor(history);
              if (history.has_more !== undefined && typeof history.has_more !== 'boolean') fail('Slack response shape invalid');
              if (!historyCursor) {
                if (history.has_more === true) fail('Slack history continuation missing');
                break;
              }
              // A cursor remains authoritative even on an empty or short page.
              if (historyCursors.has(historyCursor)) fail('Slack history cursor repeated');
              historyCursors.add(historyCursor);
            }
            complete.set(channelId, { floor, upper, truncated, items: own });
          }
          return found;
        };
        let floor = since ?? Math.max(0, cutoff - SEED_WINDOW_MS), upper = cutoff;
        let candidates: Candidate[] = [];
        let endedAtStop = false;
        for (let scans = 1; ; scans += 1) {
          const found = await scan(floor, upper);
          if (found === undefined) {
            // End the next window where the overflowing pages stopped; without that, halve toward the floor. The
            // oldest complete prefix is what the cursor may pass.
            if (scans >= MAX_WINDOW_SCANS || upper - floor < MIN_WINDOW_MS) fail('Slack history page budget exhausted');
            // The upper bound excludes its whole millisecond, so end one past the stop to read that bucket whole.
            const stopEnd = overflowReachedMs === undefined ? undefined : overflowReachedMs + 1;
            endedAtStop = stopEnd !== undefined && stopEnd > floor + 1 && stopEnd < upper;
            upper = endedAtStop && stopEnd !== undefined ? stopEnd : floor + Math.floor((upper - floor) / 2);
            overflowReachedMs = undefined;
            continue;
          }
          candidates = found;
          // A complete but empty window moves the floor, so a quiet stretch cannot hold the cursor behind a busy one.
          if (candidates.length > 0 || upper >= cutoff) break;
          // Never report "empty" for a poll that stopped short of the cutoff.
          if (scans >= MAX_WINDOW_SCANS) fail('Slack history page budget exhausted');
          // The upper bound's own millisecond was excluded from this scan, so the next window starts one before it.
          floor = upper - 1;
          // A window that ended at an overflow stop would hit the same stop again from the cutoff, so halve instead.
          upper = endedAtStop ? floor + Math.floor((cutoff - floor) / 2) : cutoff;
          endedAtStop = false;
        }
        let selected = candidates.slice(0, limit);
        const omitted = candidates[limit];
        if (omitted) selected = selected.filter(candidate => candidate.receivedAt < omitted.receivedAt);
        if (candidates.length > 0 && selected.length === 0) fail('Slack item budget cannot cover timestamp group');
        const items: InboundChannelItem[] = [];
        for (const candidate of selected) {
          checkActive(signal);
          stage = 'Slack item mapping failed';
          const mapped = await ports.mapItem({ senderId: candidate.senderId, channelId: candidate.channelId,
            subject: 'Direct message', text: candidate.text }, signal);
          checkActive(signal);
          if (!mapped) fail('Slack item mapping withheld or invalid');
          // Snapshot host accessors exactly once. Validation and projection
          // must use the same immutable primitive values, never later reads.
          const { fromDigest, subjectPreview, bodyPreview } = mapped;
          if (typeof fromDigest !== 'string' || !/^[a-f0-9]{16}$/.test(fromDigest)
            || typeof subjectPreview !== 'string' || subjectPreview.length > 200
            || typeof bodyPreview !== 'string' || bodyPreview.length > 500) fail('Slack item mapping withheld or invalid');
          // Explicit projection prevents raw/extra mapper fields from escaping.
          const item: InboundChannelItem = {
            id: `slack:${candidate.channelId}:${candidate.ts}`, provider: PROVIDER, kind: candidate.kind,
            fromDigest, subjectPreview, bodyPreview,
            receivedAt: candidate.receivedAt, unread: true,
          };
          if (ctx.resolveRouteId) {
            stage = 'Slack route resolution failed';
            try {
              const route = await ctx.resolveRouteId({ provider: PROVIDER, fromDigest: item.fromDigest, kind: item.kind });
              checkActive(signal);
              if (typeof route === 'string' && route.length > 0) item.routeId = route;
            } catch {
              checkActive(signal);
              // Optional routing cannot poison the item. Never echo exceptions.
              try { await ctx.logger.warn('Slack route resolution failed'); } catch { /* Reporting is optional. */ }
              checkActive(signal);
            }
          }
          items.push(item);
        }
        checkActive(signal);
        return { items, state: items.length ? 'ready' : 'empty', configured: true };
      } catch (error) {
        // No external exception, Slack error field, raw response, identifier,
        // credential, or message content is rendered in a result or log.
        let cancelled = false;
        // An untyped host may also supply a throwing aborted getter. Failure
        // reporting must not invoke it outside a protected boundary.
        try { cancelled = signal?.aborted === true; } catch { /* Keep the fixed stage diagnostic. */ }
        return unavailable(cancelled ? 'Slack poll cancelled' : diagnostic(error) ?? stage, configured);
      }
    },
  };
}

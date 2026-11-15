/**
 * Slack Web API inbox reader, built by the Slack account owner (slack-owner.ts),
 * which supplies HTTP and the screening mapper. This module does not redact
 * text; the mapper decides what may be stored and shown.
 *
 * Progress is kept per direct-message conversation (conversation-scan.ts), so a
 * rate limit or one unreadable conversation keeps what the tick already read.
 * The account's own id and the conversation list are read when the reader
 * starts, after a failure, and every ten minutes, not on every tick.
 */
import type { AdapterContext, InboundChannelItem, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../provider-adapter.js';
import { POLL_CADENCE_MS } from '../provider-adapter.js';
import type { ProtectedInboxPreview } from '../protected-preview.js';
import { createConversationScanState, scanConversations, ScanFailure, type ScanCandidate, type ScanPage } from './conversation-scan.js';
import { describeInboxHttpFailure, type InboxHttpResult } from './inbox-http.js';

const PROVIDER = 'slack';
const CREDENTIAL_KEY = 'surfaces.slack.botToken';
const MAX_LIST_PAGES = 50;
const HISTORY_PAGE_SIZE = 200;
/** History requests one tick may make across all conversations. */
const PAGES_PER_TICK = 40;
const MAX_ITEMS = 1_000;
/** A conversation with no cursor starts this far back, so a long-lived account is not paged from its first message. */
const SEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
/** How long a conversation list stays in use before it is read again (new conversations appear by then). */
const CATALOG_REFRESH_MS = 10 * 60 * 1_000;

/** Resolves (never rejects) after decoding and resource cleanup; the host owns deadlines and byte bounds. */
export type SlackInboxHttp = (url: URL, request: {
  method: 'GET';
  headers: { Authorization: string; Accept: 'application/json' };
  signal?: AbortSignal;
}) => Promise<InboxHttpResult>;

/** Private, raw mapper input. It must never be logged or forwarded unchanged. */
export interface SlackInboxMappingInput {
  readonly senderId: string;
  readonly channelId: string;
  readonly subject: 'Direct message';
  readonly text: string;
}

/** The screening decision for one message (see protected-preview.ts). */
export type SlackInboxMapper = (input: SlackInboxMappingInput, signal?: AbortSignal) => Promise<ProtectedInboxPreview>;

export interface SlackInboxPorts {
  readonly http: SlackInboxHttp;
  readonly mapItem: SlackInboxMapper;
  /** Unix milliseconds, captured once before any asynchronous work. */
  readonly now?: () => number;
}

/** A reader that remembers the account and its conversations between ticks. */
export interface SlackInboxAdapter extends InboundProviderAdapter {
  /** Drop what was learned about the account (a different credential is in use). */
  forget(): void;
}

class Unreadable extends Error {}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Unreadable();
  return value as Record<string, unknown>;
}
function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Unreadable();
  return value;
}
function identifier(value: unknown): string {
  const result = optionalString(value, 200);
  if (!result) throw new Unreadable();
  return result;
}
function nextCursor(response: Record<string, unknown>): string | undefined {
  if (response.response_metadata === undefined) return undefined;
  const cursor = record(response.response_metadata).next_cursor;
  return cursor === null ? undefined : optionalString(cursor, 4_096) || undefined;
}
function rows(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Unreadable();
  return value;
}
function timestamp(value: unknown): { ts: string; receivedAt: number } {
  // Slack's timestamp grammar, not a reading of message meaning. Parse decimal
  // components rather than accepting parseFloat's trailing garbage/exponents.
  if (typeof value !== 'string' || !/^\d{1,13}\.\d{6}$/.test(value)) throw new Unreadable();
  const [seconds, micros] = value.split('.');
  const receivedAt = Number(seconds) * 1_000 + Math.round(Number(micros) / 1_000);
  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) throw new Unreadable();
  return { ts: value, receivedAt };
}
function classify(message: Record<string, unknown>, self: string, text: string, ts: string): InboundChannelItem['kind'] {
  const thread = optionalString(message.thread_ts, 40);
  if (text.includes(`<@${self}>`)) return 'mention';
  return thread && thread !== ts ? 'thread' : 'dm';
}
/** Slack's own error code (a fixed token such as `missing_scope`), never free text. */
function slackErrorCode(body: Record<string, unknown>): string | undefined {
  return typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : undefined;
}
function refusal(method: string, code: string | undefined): string {
  if (code === 'invalid_auth' || code === 'not_authed' || code === 'token_revoked' || code === 'account_inactive' || code === 'token_expired') {
    return `Slack refused the token in ${CREDENTIAL_KEY} (${code}); replace it with a working token`;
  }
  if (code === 'missing_scope') return `The Slack token lacks a scope ${method} needs (missing_scope); add im:read and im:history to the Slack app and reinstall it`;
  if (code === 'ratelimited') return 'Slack is rate limiting this inbox; the next poll tries again';
  return `Slack refused ${method}${code ? ` (${code})` : ''}; the next poll tries again`;
}

export function createSlackInboxAdapter(ctx: AdapterContext, ports: SlackInboxPorts): SlackInboxAdapter {
  if (typeof ports?.http !== 'function' || typeof ports?.mapItem !== 'function') {
    throw new Error('Slack inbox requires HTTP and an explicit item mapper');
  }
  let self: string | undefined;
  let catalog: { readonly channels: ReadonlyMap<string, string | undefined>; readonly at: number } | undefined;
  const scan = createConversationScanState();
  const forget = (): void => { self = undefined; catalog = undefined; scan.resume.clear(); scan.next = undefined; };
  return {
    id: PROVIDER,
    checkpointKind: 'conversation',
    pollIntervalMs: POLL_CADENCE_MS.realtime,
    forget,
    async poll(opts: ProviderPollOptions): Promise<ProviderPollResult> {
      let configured: boolean | undefined;
      const signal = opts.signal;
      const cancelled = (): ProviderPollResult => ({ items: [], state: 'unavailable', error: describeInboxHttpFailure('Slack', 'cancelled', { credentialKey: CREDENTIAL_KEY }), ...(configured === undefined ? {} : { configured }) });
      try {
        const { limit, since, conversations } = opts;
        const cutoff = Math.floor((ports.now ?? Date.now)());
        if (!Number.isSafeInteger(cutoff) || cutoff <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS
          || (since !== undefined && (!Number.isSafeInteger(since) || since < 0))) {
          return { items: [], state: 'unavailable', error: 'The Slack inbox was asked for an invalid range; this is a defect, report it' };
        }
        if (signal?.aborted) return cancelled();
        const token = await ctx.credentials.resolveConfigSecret(CREDENTIAL_KEY);
        if (signal?.aborted) return cancelled();
        if (!token || !token.trim()) return { items: [], state: 'unavailable', error: `${CREDENTIAL_KEY} is not set; add a Slack bot or user token to read this inbox`, configured: false };
        if (!token.startsWith('xoxb-') && !token.startsWith('xoxp-')) {
          return { items: [], state: 'unavailable', error: `${CREDENTIAL_KEY} is not a Slack bot (xoxb-) or user (xoxp-) token`, configured: false };
        }
        configured = true;
        const get = async (method: 'auth.test' | 'conversations.list' | 'conversations.history', params: Record<string, string>, channel?: string) => {
          const url = new URL(`https://slack.com/api/${method}`);
          for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
          const response = await ports.http(url, {
            method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            ...(signal === undefined ? {} : { signal }),
          });
          if (!response.ok) {
            const subject = channel ? `Slack conversation ${channel}` : undefined;
            const scope = channel && (response.reason === 'not-found' || response.reason === 'denied') ? 'conversation' : 'tick';
            throw new ScanFailure(describeInboxHttpFailure('Slack', response.reason, { retryAt: response.retryAt, subject, credentialKey: CREDENTIAL_KEY,
              settingsHint: 'it is skipped until the conversation can be read again' }), scope, response.reason !== 'rate-limited');
          }
          let body: Record<string, unknown>;
          try { body = record(response.body); } catch { throw new ScanFailure(`Slack answered ${method} in a shape the inbox does not read; the next poll tries again`, 'tick', true); }
          if (body.ok !== true) {
            const code = slackErrorCode(body);
            const scope = channel && (code === 'channel_not_found' || code === 'not_in_channel') ? 'conversation' : 'tick';
            throw new ScanFailure(refusal(method, code), scope, true);
          }
          return body;
        };
        // Unknown self identity would silently turn the owner's own messages and mentions into inbound DMs.
        if (self === undefined || catalog === undefined || cutoff - catalog.at >= CATALOG_REFRESH_MS || cutoff < catalog.at) {
          try {
            self = identifier((await get('auth.test', {})).user_id);
            const channels = new Map<string, string | undefined>();
            let cursor: string | undefined;
            const seen = new Set<string>();
            for (let page = 0; ; page += 1) {
              if (page >= MAX_LIST_PAGES) throw new ScanFailure(`This Slack account has more direct-message conversations than the inbox lists (${String(MAX_LIST_PAGES * 100)})`, 'tick', true);
              const list = await get('conversations.list', { types: 'im', limit: '100', ...(cursor ? { cursor } : {}) });
              for (const entry of rows(list.channels, 100)) {
                const channel = record(entry);
                channels.set(identifier(channel.id), optionalString(channel.user, 200));
              }
              cursor = nextCursor(list);
              if (!cursor || seen.has(cursor)) break;
              seen.add(cursor);
            }
            catalog = { channels, at: cutoff };
          } catch (error) {
            catalog = undefined;
            throw error;
          }
        }
        const me = self!;
        const known = catalog!.channels;
        const readPage = async (channel: string, window: { floor: number; upper: number; continueFrom?: string }): Promise<ScanPage> => {
          if (signal?.aborted) throw new ScanFailure(describeInboxHttpFailure('Slack', 'cancelled', { credentialKey: CREDENTIAL_KEY }), 'tick', false);
          const history = await get('conversations.history', {
            channel, limit: String(HISTORY_PAGE_SIZE), latest: window.continueFrom ?? (window.upper / 1_000).toFixed(6),
            oldest: (window.floor / 1_000).toFixed(6),
          }, channel);
          try {
            const candidates: ScanCandidate[] = [];
            let oldestTs: string | undefined;
            let oldestMs = Number.POSITIVE_INFINITY;
            for (const entry of rows(history.messages, HISTORY_PAGE_SIZE)) {
              const message = record(entry);
              const { ts, receivedAt } = timestamp(message.ts);
              if (receivedAt < oldestMs) { oldestMs = receivedAt; oldestTs = ts; }
              const subtype = optionalString(message.subtype, 200);
              const author = optionalString(message.user, 200);
              // Bot posts and the account's own messages are not inbound mail to the owner.
              if (subtype === 'bot_message' || optionalString(message.bot_id, 200) || author === me) continue;
              const text = optionalString(message.text, 40_000) ?? '';
              candidates.push({ key: `${channel}:${ts}`, conversation: channel, senderId: author || known.get(channel) || channel,
                text, receivedAt, kind: classify(message, me, text, ts) });
            }
            if (history.has_more !== undefined && typeof history.has_more !== 'boolean') throw new Unreadable();
            const more = history.has_more === true && oldestTs !== undefined && oldestMs > window.floor;
            return { candidates, ...(more ? { next: oldestTs! } : {}) };
          } catch (error) {
            if (error instanceof ScanFailure) throw error;
            throw new ScanFailure(`Slack answered conversations.history for conversation ${channel} in a shape the inbox does not read; it is skipped this poll`, 'conversation', false);
          }
        };
        const tsOf = (candidate: ScanCandidate): string => candidate.key.slice(candidate.key.indexOf(':') + 1);
        const outcome = await scanConversations({
          conversations: [...known.keys()].sort(),
          floorOf: channel => conversations?.get(channel) ?? since ?? Math.max(0, cutoff - SEED_WINDOW_MS),
          cutoff, limit, pageBudget: PAGES_PER_TICK, state: scan, readPage,
          map: candidate => ports.mapItem({ senderId: candidate.senderId, channelId: candidate.conversation, subject: 'Direct message', text: candidate.text }, signal),
          toItem: (candidate, fields): InboundChannelItem => ({
            id: `slack:${candidate.conversation}:${tsOf(candidate)}`, provider: PROVIDER, kind: candidate.kind,
            fromDigest: fields.fromDigest, subjectPreview: fields.subjectPreview, bodyPreview: fields.bodyPreview,
            receivedAt: candidate.receivedAt, unread: true,
          }),
          checkActive() { if (signal?.aborted) throw new ScanFailure(describeInboxHttpFailure('Slack', 'cancelled', { credentialKey: CREDENTIAL_KEY }), 'tick', false); },
        });
        if (ctx.resolveRouteId) for (const item of outcome.items) {
          try {
            const route = await ctx.resolveRouteId({ provider: PROVIDER, fromDigest: item.fromDigest, kind: item.kind });
            if (typeof route === 'string' && route.length > 0) item.routeId = route;
          } catch {
            // Optional routing cannot poison the item. Never echo exceptions.
            try { await ctx.logger.warn('Slack route resolution failed'); } catch { /* Reporting is optional. */ }
          }
        }
        if (outcome.failure?.refreshCatalog) catalog = undefined;
        const progress = Object.keys(outcome.advance).length > 0 ? { conversationAdvance: outcome.advance } : {};
        if (outcome.failure) return { items: outcome.items, state: 'unavailable', error: outcome.failure.message, configured: true, ...progress };
        return { items: outcome.items, state: outcome.items.length ? 'ready' : 'empty', configured: true, ...progress };
      } catch (error) {
        catalog = undefined;
        if (signal?.aborted) return cancelled();
        return { items: [], state: 'unavailable', ...(configured === undefined ? {} : { configured }),
          error: error instanceof ScanFailure ? error.message : 'Slack answered in a shape the inbox does not read; the next poll tries again' };
      }
    },
  };
}

/**
 * Discord REST inbox reader, built by the Discord account owner
 * (discord-owner.ts), which supplies HTTP, the configured channel catalog and
 * the screening mapper.
 *
 * Progress is kept per channel (conversation-scan.ts), so a rate limit or one
 * unreadable channel keeps what the tick already read. The bot's own id and the
 * channel catalog are checked when the reader starts, after a failure, and every
 * ten minutes, not on every tick.
 */
import type { AdapterContext, InboundChannelItem, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../provider-adapter.js';
import { POLL_CADENCE_MS } from '../provider-adapter.js';
import type { ProtectedInboxPreview } from '../protected-preview.js';
import { createConversationScanState, scanConversations, ScanFailure, type ScanCandidate, type ScanPage } from './conversation-scan.js';
import { describeInboxHttpFailure, type InboxHttpFailure, type InboxHttpResult } from './inbox-http.js';

const PROVIDER = 'discord';
const CREDENTIAL_KEY = 'surfaces.discord.botToken';
const CHANNELS_SETTING = 'surfaces.discord.inboxChannelIds';
const EPOCH_MS = 1_420_070_400_000;
const MAX_SNOWFLAKE = (1n << 64n) - 1n;
const MAX_CHANNELS = 200;
const PAGE_SIZE = 100;
/** History requests one tick may make across all channels. */
const PAGES_PER_TICK = 40;
const MAX_ITEMS = 1_000;
/** A channel with no cursor starts this far back, so a long-lived account is not paged from its first message. */
const SEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
/** How long a checked catalog stays in use before the channels are checked again. */
const CATALOG_REFRESH_MS = 10 * 60 * 1_000;

/** Resolves (never rejects) after decoding and cleanup; the host owns deadlines and byte bounds. */
export type DiscordInboxHttp = (url: URL, request: {
  method: 'GET';
  headers: { Authorization: string; Accept: 'application/json' };
  signal?: AbortSignal;
}) => Promise<InboxHttpResult>;

export interface DiscordInboxCatalogSnapshot {
  readonly accountId: string;
  /** Configured channels this account can read. */
  readonly channels: readonly { readonly id: string; readonly type: 1 }[];
  /** Configured channels that could not be read, with why; the others are still read. */
  readonly unreadable: readonly { readonly id: string; readonly reason: InboxHttpFailure | 'not-a-dm'; readonly retryAt?: number }[];
}
/**
 * Bot REST has no endpoint that lists DMs, so the owner supplies the
 * configured channels and checks each one. It settles only after its work is drained.
 */
export type DiscordInboxCatalog = (input: {
  readonly selfId: string;
  readonly signal?: AbortSignal;
}) => Promise<DiscordInboxCatalogSnapshot>;

/** Raw private input; never log or forward unchanged. */
export interface DiscordInboxMappingInput {
  readonly senderId: string;
  readonly channelId: string;
  readonly subject: 'Direct message';
  readonly text: string;
}
/** The screening decision for one message (see protected-preview.ts). */
export type DiscordInboxMapper = (input: DiscordInboxMappingInput, signal?: AbortSignal) => Promise<ProtectedInboxPreview>;
export interface DiscordInboxPorts {
  readonly http: DiscordInboxHttp;
  readonly listDmChannels: DiscordInboxCatalog;
  readonly mapItem: DiscordInboxMapper;
  /** Unix milliseconds, captured once before asynchronous work. */
  readonly now?: () => number;
}

/** A reader that remembers the bot and its channels between ticks. */
export interface DiscordInboxAdapter extends InboundProviderAdapter {
  /** Drop what was learned about the account (a different credential is in use). */
  forget(): void;
}

class Unreadable extends Error {}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Unreadable();
  return value as Record<string, unknown>;
}
function rows(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Unreadable();
  return value;
}
function snowflake(value: unknown): { id: string; value: bigint; ms: number } {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw new Unreadable();
  const numeric = BigInt(value);
  if (numeric > MAX_SNOWFLAKE) throw new Unreadable();
  return { id: value, value: numeric, ms: Number(numeric >> 22n) + EPOCH_MS };
}
function classify(message: Record<string, unknown>, self: string): InboundChannelItem['kind'] {
  const mentions = message.mentions === undefined ? [] : rows(message.mentions, 1_000);
  const reference = message.referenced_message;
  if (reference !== undefined && reference !== null) record(reference);
  if (mentions.some(value => snowflake(record(value).id).id === self)) return 'mention';
  return reference ? 'thread' : 'dm';
}
function unreadableText(entry: DiscordInboxCatalogSnapshot['unreadable'][number]): string {
  const subject = `Discord channel ${entry.id} (in ${CHANNELS_SETTING})`;
  if (entry.reason === 'not-a-dm') return `${subject} is not a one-to-one direct message channel; remove it from ${CHANNELS_SETTING}`;
  return describeInboxHttpFailure('Discord', entry.reason, { retryAt: entry.retryAt, subject, credentialKey: CREDENTIAL_KEY,
    settingsHint: `remove it from ${CHANNELS_SETTING} or restore the bot's access` });
}

export function createDiscordInboxAdapter(ctx: AdapterContext, ports: DiscordInboxPorts): DiscordInboxAdapter {
  if (typeof ports?.http !== 'function' || typeof ports?.mapItem !== 'function'
    || typeof ports?.listDmChannels !== 'function') {
    throw new Error('Discord inbox requires HTTP, a channel catalog and an explicit item mapper');
  }
  let self: string | undefined;
  let catalog: { readonly snapshot: DiscordInboxCatalogSnapshot; readonly at: number } | undefined;
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
      const cancelledText = describeInboxHttpFailure('Discord', 'cancelled', { credentialKey: CREDENTIAL_KEY });
      const cancelled = (): ProviderPollResult => ({ items: [], state: 'unavailable', error: cancelledText, ...(configured === undefined ? {} : { configured }) });
      try {
        const { limit, since, conversations } = opts;
        const cutoff = Math.floor((ports.now ?? Date.now)());
        if (!Number.isSafeInteger(cutoff) || cutoff <= EPOCH_MS || cutoff > Number(MAX_SNOWFLAKE >> 22n) + EPOCH_MS
          || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS
          || (since !== undefined && (!Number.isSafeInteger(since) || since < 0))) {
          return { items: [], state: 'unavailable', error: 'The Discord inbox was asked for an invalid range; this is a defect, report it' };
        }
        if (signal?.aborted) return cancelled();
        const token = await ctx.credentials.resolveConfigSecret(CREDENTIAL_KEY);
        if (signal?.aborted) return cancelled();
        if (!token || !token.trim()) return { items: [], state: 'unavailable', error: `${CREDENTIAL_KEY} is not set; add the Discord bot token to read this inbox`, configured: false };
        configured = true;
        const get = async (path: string, params: Record<string, string>, channel?: string): Promise<unknown> => {
          const url = new URL(`https://discord.com/api/v10${path}`);
          for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
          const response = await ports.http(url, {
            method: 'GET', headers: { Authorization: `Bot ${token}`, Accept: 'application/json' },
            ...(signal === undefined ? {} : { signal }),
          });
          if (!response.ok) {
            const scoped = channel !== undefined && (response.reason === 'denied' || response.reason === 'not-found');
            throw new ScanFailure(scoped ? unreadableText({ id: channel, reason: response.reason })
              : describeInboxHttpFailure('Discord', response.reason, { retryAt: response.retryAt, credentialKey: CREDENTIAL_KEY }),
            scoped ? 'conversation' : 'tick', response.reason !== 'rate-limited');
          }
          return response.body;
        };
        if (self === undefined || catalog === undefined || cutoff - catalog.at >= CATALOG_REFRESH_MS || cutoff < catalog.at) {
          try {
            self = snowflake(record(await get('/users/@me', {})).id).id;
            const snapshot = await ports.listDmChannels({ selfId: self, ...(signal === undefined ? {} : { signal }) });
            if (snapshot.accountId !== self) throw new ScanFailure('The Discord channel catalog belongs to another bot; the next poll checks it again', 'tick', true);
            if (snapshot.channels.length > MAX_CHANNELS) throw new ScanFailure(`More than ${String(MAX_CHANNELS)} channels are configured in ${CHANNELS_SETTING}`, 'tick', true);
            catalog = { snapshot, at: cutoff };
          } catch (error) {
            catalog = undefined;
            throw error;
          }
        }
        const me = self!;
        const snapshot = catalog!.snapshot;
        const readPage = async (channel: string, window: { floor: number; upper: number; continueFrom?: string }): Promise<ScanPage> => {
          if (signal?.aborted) throw new ScanFailure(cancelledText, 'tick', false);
          const before = window.continueFrom ?? (BigInt(window.upper - EPOCH_MS) << 22n).toString();
          const body = await get(`/channels/${channel}/messages`, { limit: String(PAGE_SIZE), before }, channel);
          try {
            const messages = rows(body, PAGE_SIZE);
            const candidates: ScanCandidate[] = [];
            let oldest: { id: string; value: bigint; ms: number } | undefined;
            for (const entry of messages) {
              const message = record(entry);
              const id = snowflake(message.id);
              if (id.value >= BigInt(before)) throw new Unreadable();
              if (!oldest || id.value < oldest.value) oldest = id;
              if (message.channel_id !== undefined && snowflake(message.channel_id).id !== channel) throw new Unreadable();
              const authorValue = message.author;
              const author = authorValue === undefined ? undefined : record(authorValue);
              const bot = author?.bot;
              if (bot !== undefined && typeof bot !== 'boolean') throw new Unreadable();
              const authorId = author === undefined ? undefined : snowflake(author.id).id;
              // Bot posts, the inbox bot's own included, are not inbound mail to the owner.
              if (bot === true || authorId === me) continue;
              const text = message.content ?? '';
              if (typeof text !== 'string' || text.length > 40_000) throw new Unreadable();
              // One ordering for pagination and the cursor: the id's own time.
              candidates.push({ key: `${channel}:${id.id}`, conversation: channel, senderId: authorId ?? channel, text,
                receivedAt: id.ms, kind: classify(message, me) });
            }
            const more = messages.length === PAGE_SIZE && oldest !== undefined && oldest.ms > window.floor;
            return { candidates, ...(more ? { next: oldest!.id } : {}) };
          } catch {
            throw new ScanFailure(`Discord answered the history of channel ${channel} in a shape the inbox does not read; it is skipped this poll`, 'conversation', false);
          }
        };
        const outcome = await scanConversations({
          conversations: snapshot.channels.map(channel => channel.id).sort(),
          floorOf: channel => conversations?.get(channel) ?? since ?? Math.max(0, cutoff - SEED_WINDOW_MS),
          cutoff, limit, pageBudget: PAGES_PER_TICK, state: scan, readPage,
          map: candidate => ports.mapItem({ senderId: candidate.senderId, channelId: candidate.conversation, subject: 'Direct message', text: candidate.text }, signal),
          toItem: (candidate, fields): InboundChannelItem => ({
            id: `discord:${candidate.key}`, provider: PROVIDER, kind: candidate.kind,
            fromDigest: fields.fromDigest, subjectPreview: fields.subjectPreview, bodyPreview: fields.bodyPreview,
            receivedAt: candidate.receivedAt, unread: true,
          }),
          checkActive() { if (signal?.aborted) throw new ScanFailure(cancelledText, 'tick', false); },
        });
        if (ctx.resolveRouteId) for (const item of outcome.items) {
          try {
            const route = await ctx.resolveRouteId({ provider: PROVIDER, fromDigest: item.fromDigest, kind: item.kind });
            if (typeof route === 'string' && route.length > 0) item.routeId = route;
          } catch {
            try { await ctx.logger.warn('Discord route resolution failed'); } catch { /* Optional reporting. */ }
          }
        }
        if (outcome.failure?.refreshCatalog) catalog = undefined;
        const progress = Object.keys(outcome.advance).length > 0 ? { conversationAdvance: outcome.advance } : {};
        // Configured channels that could not be read are named, every poll, until fixed.
        const problems = [...(outcome.failure ? [outcome.failure.message] : []), ...snapshot.unreadable.map(unreadableText)];
        if (problems.length > 0) {
          return { items: outcome.items, state: 'unavailable', error: problems.join('; '), configured: true, ...progress };
        }
        return { items: outcome.items, state: outcome.items.length ? 'ready' : 'empty', configured: true, ...progress };
      } catch (error) {
        catalog = undefined;
        if (signal?.aborted) return cancelled();
        return { items: [], state: 'unavailable', ...(configured === undefined ? {} : { configured }),
          error: error instanceof ScanFailure ? error.message : 'Discord answered in a shape the inbox does not read; the next poll tries again' };
      }
    },
  };
}

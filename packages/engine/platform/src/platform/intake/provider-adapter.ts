// ---------------------------------------------------------------------------
// Inbound provider adapter contract.
//
// Each adapter owns ONE provider (slack, discord, email). The poller calls
// adapter.poll() on the adapter's cadence and commits what it returns, rows and
// progress together, through the cursor store. A pushed adapter (email) is
// never polled: the mailbox reader hands it mail and it commits rows through
// the sink the poller binds to it. Every adapter is built by its
// account owner (providers/*-owner.ts), which supplies credentials, the HTTP or
// mail client and privacy screening; adapters never return raw sender ids or
// unscreened text.
//
// When a credential is missing or unusable an adapter returns state
// 'unavailable' with `configured: false`, so a caller can tell "not wired up"
// from "wired up and failing".
// ---------------------------------------------------------------------------

import type { IntakeCredentialStore, IntakeLogger } from './context.js';

/**
 * Daemon-internal inbound item. This is NOT the platform wire shape, the inbox
 * surface maps it onto the platform `CHANNEL_INBOX_ITEM_SCHEMA` shape
 * (`from`/`subject`/`bodyPreview`/...) before returning. `fromDigest` is the
 * redacted sender (the only sender value that ever leaves the daemon).
 */
export interface InboundChannelItem {
  /** Stable, provider-scoped dedup key. Idempotent across polls. */
  id: string;
  provider: string;
  kind: 'dm' | 'thread' | 'mention' | 'reaction';
  /**
   * sha256First(senderExternalId, 16), NEVER the raw id. 16 hex chars == the
   * first 8 bytes of the SHA-256 digest.
   */
  fromDigest: string;
  /** <= 200 chars, safe for display. */
  subjectPreview: string;
  /** <= 500 chars, plain text, PII-stripped. */
  bodyPreview: string;
  /** Daemon route binding id, when resolvable. */
  routeId?: string;
  /** Unix ms. */
  receivedAt: number;
  unread: boolean;
  /** Triage label for the row's current content, read from the mirror; never written by an adapter. */
  triageLabel?: 'spam' | 'priority' | 'normal';
  triageScore?: number;
  triageTags?: string[];
}

export type ProviderState = 'ready' | 'unavailable' | 'empty' | 'pending';

export interface ProviderPollResult {
  items: InboundChannelItem[];
  state: ProviderState;
  /** Present only when state === 'unavailable'. */
  error?: string;
  /**
   * Whether this provider's credentials resolved.
   *
   * 'unavailable' alone conflates two things a reader has to tell apart: a
   * provider nobody has wired up yet, and a wired-up provider whose API just
   * refused us. The first is a normal state of a fresh install and the second
   * is an outage hiding items that exist, and `channels.inbox.list` reports
   * them as different states because a caller acts on them differently.
   *
   * `false`, no credential (or an unusable one), so nothing was even asked.
   * `true` , credentials resolved; whatever happened next happened WITH them.
   * absent , the adapter could not find out (the credential store itself
   *           failed), which is neither claim and is reported as neither.
   */
  configured?: boolean;
  /**
   * Conversation adapters only: for each conversation read completely this
   * poll, the newest time read. Committed with `items` even when `state` is
   * 'unavailable', so what was read is kept and the next poll starts there.
   */
  conversationAdvance?: Readonly<Record<string, number>>;
}

export interface ProviderPollOptions {
  /** Cooperative cancellation for leadership loss or surface shutdown. */
  signal?: AbortSignal;
  /** Only return items newer than this Unix-ms timestamp, when supported. */
  since?: number;
  /** Conversation adapters only: each conversation's own cursor (Unix ms), keyed by conversation id. */
  conversations?: ReadonlyMap<string, number>;
  /** Max items to return this poll. */
  limit: number;
}

/** Context handed to every adapter at construction time. */
export interface AdapterContext {
  readonly credentials: IntakeCredentialStore;
  readonly logger: IntakeLogger;
  /**
   * Optional route resolver supplied by the routing surface. Returns the route
   * binding id for a given inbound item, or undefined when no route matches /
   * the routing surface is not wired yet. Adapters/poller call this best-effort.
   */
  readonly resolveRouteId?: RouteResolver;
}

/**
 * Best-effort route resolution seam. The routing surface injects its
 * profile-backed implementation via the inbox bridge. Until then it is
 * undefined and items carry no routeId.
 */
export type RouteResolver = (input: {
  provider: string;
  fromDigest: string;
  kind: InboundChannelItem['kind'];
}) => Promise<string | undefined> | string | undefined;

export interface InboundProviderAdapter {
  /** Provider id, e.g. 'slack'. Must be unique within the registry. */
  readonly id: string;
  /**
   * How progress is kept: 'conversation' for one cursor per conversation,
   * 'pushed' for a provider whose rows arrive from its own reader (the
   * mailbox reader) and is never polled; absent for one provider-wide timestamp.
   */
  readonly checkpointKind?: 'conversation' | 'pushed';
  /** Fences account/source currentness synchronously at commit. */
  readonly assertCurrent?: () => void;
  /**
   * Poll cadence in ms. Slack/Discord 30s, everything else 120s.
   * The poller reads this to schedule its per-provider interval.
   */
  readonly pollIntervalMs: number;
  /**
   * Pull recent DMs/threads/mentions. MUST resolve (never reject), failures
   * are reported via state:'unavailable' + error so one bad provider cannot
   * crash the aggregate feed. Never called for a pushed adapter.
   */
  poll(opts: ProviderPollOptions): Promise<ProviderPollResult>;
  /** Pushed adapters: bound once the store is open; returns its unbind. */
  bind?(sink: PushedProviderSink): () => void;
  /** Pushed adapters: what `channels.inbox.list` reports for this provider. */
  status?(): PushedProviderStatus;
  /** Pushed adapters: whether its reader is reading on this node now. */
  isRunning?(): boolean;
}

/** Where a pushed adapter writes: the account's own mirror, through the poller. */
export interface PushedProviderSink {
  /**
   * Store rows in one transaction. With a generation, rows of any other
   * generation of this provider are dropped first and the new one recorded.
   * Returns the number of rows new to the mirror.
   */
  commit(items: readonly InboundChannelItem[], generation: number | null): Promise<number>;
  /** Whether the mirror already holds this row. One indexed lookup. */
  has(id: string): boolean;
  /** The generation the mirror's rows belong to, or null when none was recorded. */
  generation(): number | null;
  /** Whether a generation was ever recorded for this provider in this mirror. */
  seeded(): boolean;
}

/** A pushed provider's own report, in the poller's status vocabulary. */
export interface PushedProviderStatus {
  readonly state: ProviderState;
  readonly itemCount: number;
  readonly polled: boolean;
  readonly error?: string;
  readonly lastPolledAt?: number;
  readonly configured?: boolean;
  readonly mailboxProgress?: { readonly uidValidity: number; readonly pendingMessages: number };
  /** The account scope this mailbox's rows are named under (`email:<scope>:<uidvalidity>:<uid>`). */
  readonly mailboxScope?: string;
  readonly mailboxHistory?: {
    readonly kind: 'complete' | 'bounded-seed';
    readonly lowerBoundUid: number;
    readonly skippedOlderMessages: number;
    readonly uidValidity: number;
  };
  readonly skippedMessages?: readonly { readonly uid: number; readonly reason: string }[];
}

// ---------------------------------------------------------------------------
// Cadence constants (single source of truth, referenced by adapters + tests).
// ---------------------------------------------------------------------------

export const POLL_CADENCE_MS = {
  realtime: 30_000, // slack, discord
  default: 120_000,
} as const;

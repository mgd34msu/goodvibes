// ---------------------------------------------------------------------------
// Inbound provider adapter contract.
//
// Each adapter owns ONE provider (slack, discord, email). The poller calls
// adapter.poll() on the adapter's cadence and commits what it returns, rows and
// progress together, through the cursor store. Every adapter is built by its
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

/** IMAP progress is independent of untrusted message Date headers. */
export interface ImapUidCheckpoint {
  readonly kind: 'imap-uid';
  readonly uidValidity: number;
  /** Null until an actual UID reaches a terminal protected disposition. */
  readonly lastTerminalUid: number | null;
  readonly history: {
    readonly kind: 'complete' | 'bounded-seed';
    /** Inclusive first UID eligible for intake; older history is not consumed. */
    readonly lowerBoundUid: number;
    /** Count omitted when the baseline was chosen, never a processed count. */
    readonly skippedOlderMessages: number;
  };
}

export type ImapUidTerminalDisposition =
  | { readonly uid: number; readonly disposition: 'published'; readonly itemId: string }
  | { readonly uid: number; readonly disposition: 'suppressed' | 'gone' };

/**
 * Trusted adapter proposal, never authority derived from message fields.
 * Seed/reset commits pin history before any content read. They carry no rows,
 * terminal UIDs, or processed watermark. Subsequent advances cover the entire
 * oldest pending page, including terminally suppressed/confirmed gone UIDs.
 */
export interface ImapUidCheckpointAdvance {
  readonly kind: 'imap-uid';
  readonly transition: 'seed' | 'advance' | 'reset';
  readonly previous: ImapUidCheckpoint | null;
  readonly next: ImapUidCheckpoint;
  readonly coveredUids: readonly number[];
  readonly terminal: readonly ImapUidTerminalDisposition[];
}

export type ProviderState = 'ready' | 'unavailable' | 'empty' | 'pending';

export interface ProviderPollResult {
  /** Last observed eligible messages still pending in checkpointAdvance.next.uidValidity. */
  readonly pendingMessages?: number;
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
  /** Durable UID progress, atomically committed with only the redacted items. */
  checkpointAdvance?: ImapUidCheckpointAdvance;
  /** UIDs this poll passed without publishing because their content cannot be proven complete. */
  skippedMessages?: readonly { readonly uid: number; readonly reason: string }[];
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
  /** IMAP-only checkpoint. Timestamp providers keep their existing since semantics. */
  checkpoint?: ImapUidCheckpoint;
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
   * How progress is kept: 'imap-uid' for a mailbox checkpoint, 'conversation'
   * for one cursor per conversation; absent for one provider-wide timestamp.
   */
  readonly checkpointKind?: 'imap-uid' | 'conversation';
  /** UID adapters must fence account/source currentness synchronously at commit. */
  readonly assertCurrent?: () => void;
  /**
   * Poll cadence in ms. Slack/Discord 30s, email 60s, everything else 120s.
   * The poller reads this to schedule its per-provider interval.
   */
  readonly pollIntervalMs: number;
  /**
   * Pull recent DMs/threads/mentions. MUST resolve (never reject), failures
   * are reported via state:'unavailable' + error so one bad provider cannot
   * crash the aggregate feed.
   */
  poll(opts: ProviderPollOptions): Promise<ProviderPollResult>;
}

// ---------------------------------------------------------------------------
// Cadence constants (single source of truth, referenced by adapters + tests).
// ---------------------------------------------------------------------------

export const POLL_CADENCE_MS = {
  realtime: 30_000, // slack, discord
  email: 60_000,
  default: 120_000,
} as const;

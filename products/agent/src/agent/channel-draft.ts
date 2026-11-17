/**
 * channel-draft.ts
 *
 * Outbox + draft model for channel messages.
 *
 * Provides:
 *   - `ChannelDraft`, a composed-but-not-yet-sent message
 *   - `saveDraft`   , persist a draft, offering it to the daemon first
 *   - `listDrafts`  , read the local mirror
 *   - `fetchDaemonDrafts` / `mergeDraftViews`, the cross-surface view
 *   - `getDraft`    , read one draft by id
 *   - `deleteDraft` , remove a draft, here and on the daemon
 *   - `queueDraftToSend`, promote a draft to a confirmed send input, consuming it
 *
 * A draft is composed on one surface and very often finished on another: the
 * phone writes it, the terminal sends it. So the store of record is the
 * daemon's, `channels.drafts.*`, and this file is an outbox: it holds the
 * drafts this Agent wrote, so one composed while the daemon was unreachable is
 * not lost (it says `pending` and carries the daemon's own words), and a draft
 * written elsewhere is brought in from the daemon, text and all, when it is
 * sent from here (`adoptDaemonDraft`). The daemon's list carries no text; its
 * `get` serves the text to the owner.
 *
 * Sends always route through the EXISTING `deliverAgentChannelMessage` path
 * (which wraps `ChannelDeliveryRouter.deliver` via the agent_channel_send
 * confirm pattern). Adopting the daemon's draft STORE does not move where a
 * send happens.
 *
 * Persistence: JSON file at {agentRoot}/channels/drafts.json via ShellPathService.
 */

import { channelDraftWireReference, createChannelDraftWireReference, historicalChannelDraftWireReference, isNativeDraftWireReference, matchesHistoricalDraftWireReference } from '@goodvibes-jev/engine/platform/platform/channels';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  prepareJsonStoreWrite,
  readJsonStore,
  runStoreFileUpdateSync,
  writeStoreFile,
  type JsonStoreContents,
  type JsonStoreSpec,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { retainChannelStoreSource, type ChannelStoreEffectOptions } from './channel-store-lifetime.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { AgentChannelDeliveryInput } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { defineLifecycle } from '@goodvibes-jev/engine/platform/platform/utils';
import type { DaemonInvokeFailureKind, DaemonOperatorInvoke } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

export const CHANNEL_DRAFTS_LIST_METHOD = 'channels.drafts.list';
export const CHANNEL_DRAFTS_GET_METHOD = 'channels.drafts.get';
/** The most drafts one `channels.drafts.list` call accepts; a larger limit is refused by the daemon. */
const DAEMON_DRAFT_LIST_MAX = 200;
export const CHANNEL_DRAFTS_SAVE_METHOD = 'channels.drafts.save';
export const CHANNEL_DRAFTS_DELETE_METHOD = 'channels.drafts.delete';

/** Where a draft stands with the daemon's store. */
export type ChannelDraftSyncState = 'synced' | 'pending';

/** The result of offering one draft to the daemon. */
export type ChannelDraftSyncOutcome =
  | { readonly synced: true; readonly wireReference?: string }
  | { readonly synced: false; readonly kind: DaemonInvokeFailureKind | 'not_attempted'; readonly error: string };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelDraftStatus = 'draft' | 'queued' | 'sent' | 'failed';

/**
 * A draft is queued once per delivery attempt: queueDraftToSend hands out the
 * delivery input only on a move into 'queued', written before anything is
 * sent, so an already queued draft cannot be sent twice. 'queued' with no
 * recorded outcome means the delivery may have happened: it is never queued
 * again, however old. 'sent' is final. A failed delivery may be queued again
 * as a retry. (saveDraft edits a draft's content and may set any status; this
 * table governs the send-path writers.)
 */

export const channelDraftLifecycle = defineLifecycle<ChannelDraftStatus>('channel draft', {
  // A delivery outcome is a fact about something that already happened, so it
  // is recorded from any status except `sent` (a draft can be edited back to
  // `draft` while its delivery is in flight). `sent` is final.
  draft: ['queued', 'sent', 'failed'],
  queued: ['sent', 'failed'],
  sent: [],
  failed: ['queued', 'sent', 'failed'],
});

export interface ChannelDraft {
  readonly wireReference?: string;
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ChannelDraftStatus;
  /** Human-readable subject / title. */
  readonly title?: string;
  /** Message body. */
  readonly message: string;
  /** Surface target shorthand: e.g. "slack:ops" */
  readonly channel?: string;
  /** Named route id. */
  readonly route?: string;
  /**
   * A webhook URL written before webhook URLs moved to the secret store. It is
   * read so such a draft can still be sent, and moves into the secret store the
   * next time the draft is saved or sent with one available. Never written for a new draft.
   */
  readonly webhook?: string;
  /** Secret-store key holding this draft's webhook URL, a bearer secret that is never written to the draft file. */
  readonly webhookSecretKey?: string;
  /** Link address. */
  readonly link?: string;
  /** Optional tags for grouping drafts. */
  readonly tags?: readonly string[];
  /** If the draft was sent, the delivery response id. */
  readonly sentResponseId?: string;
  /** If the draft failed to send, the error message. */
  readonly sendError?: string;
  /** Whether the daemon's store holds this draft, so other surfaces see it. */
  readonly daemonSyncState?: ChannelDraftSyncState;
  /** Why the daemon does not hold it, in the daemon's words. */
  readonly syncError?: string;
  /** Where this view of the draft came from. Never persisted. */
  readonly origin?: 'local' | 'daemon';
  /** The daemon's list carries no text; open the draft (`fetchDaemonDraft`) to read it. Never persisted. */
  readonly bodyUnavailable?: true;
}

/** The secret store a draft's webhook URL lives in; the shell's SecretsManager satisfies it. */
export interface ChannelDraftWebhookSecrets {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly delete?: (key: string) => Promise<void>;
}

/** Store options for the writers that may touch a draft's webhook secret. */
export interface ChannelDraftStoreOptions extends ChannelStoreEffectOptions {
  readonly webhookSecrets?: ChannelDraftWebhookSecrets;
}

export interface ChannelDraftSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly drafts: readonly ChannelDraft[];
  readonly parseError?: string;
  /** Stored drafts this version cannot read; they stay in the file as found. */
  readonly unreadableEntries?: number;
}

export interface ChannelDraftSaveResult {
  readonly draft: ChannelDraft;
  readonly path: string;
  /** What the daemon said when this draft was offered to its store. */
  readonly daemon: ChannelDraftSyncOutcome;
}

export interface ChannelDraftDeleteResult {
  readonly deleted: boolean;
  /** What the daemon said when asked to drop its copy. */
  readonly daemon: ChannelDraftSyncOutcome;
}

export interface ChannelDraftQueueResult {
  /** The draft id that was promoted. */
  readonly draftId: string;
  /** The delivery input ready to pass to deliverAgentChannelMessage. */
  readonly deliveryInput: AgentChannelDeliveryInput;
  /** The updated draft (status: 'queued'). */
  readonly draft: ChannelDraft;
}

// ---------------------------------------------------------------------------
// Internal file model
// ---------------------------------------------------------------------------

type ShellPaths = Pick<ShellPathService, 'resolveUserPath'>;

const DRAFT_VERSION = 1 as const;
const DRAFT_FILE_VERSION = 1 as const;
/** The most drafts the outbox keeps; past it the oldest sent drafts go first, and an unsent one never does. */
const DRAFT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export function channelDraftFilePath(shellPaths: ShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'channels', 'drafts.json');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptString(value: unknown): string | undefined {
  const s = readString(value);
  return s || undefined;
}

function parseDraftStatus(value: unknown): ChannelDraftStatus {
  if (value === 'queued' || value === 'sent' || value === 'failed') return value;
  return 'draft';
}

function parseTags(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.map(readString).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function parseDraft(value: unknown): ChannelDraft | null {
  if (!isRecord(value) || value.version !== DRAFT_VERSION) return null;
  const id = readString(value.id);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  const message = readString(value.message);
  if (!id || !createdAt || !updatedAt || !message) return null;
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null;
  return {
    version: DRAFT_VERSION,
    id,
    ...(value.wireReference === undefined ? {} : { wireReference: channelDraftWireReference(id, readString(value.wireReference)) }),
    createdAt,
    updatedAt,
    status: parseDraftStatus(value.status),
    message,
    ...( readOptString(value.title) ? { title: readOptString(value.title) } : {}),
    ...( readOptString(value.channel) ? { channel: readOptString(value.channel) } : {}),
    ...( readOptString(value.route) ? { route: readOptString(value.route) } : {}),
    ...( readOptString(value.webhook) ? { webhook: readOptString(value.webhook) } : {}),
    ...( readOptString(value.webhookSecretKey) ? { webhookSecretKey: readOptString(value.webhookSecretKey) } : {}),
    ...( readOptString(value.link) ? { link: readOptString(value.link) } : {}),
    ...(parseTags(value.tags) ? { tags: parseTags(value.tags) } : {}),
    ...( readOptString(value.sentResponseId) ? { sentResponseId: readOptString(value.sentResponseId) } : {}),
    ...( readOptString(value.sendError) ? { sendError: readOptString(value.sendError) } : {}),
    // Anything other than an explicit 'synced', including a record written
    // before the daemon held this store, is a draft the daemon has not been
    // told about, which is what pending means.
    daemonSyncState: value.daemonSyncState === 'synced' ? 'synced' : 'pending',
    ...( readOptString(value.syncError) ? { syncError: readOptString(value.syncError) } : {}),
  };
}

/** Strip the fields that describe a VIEW rather than the draft itself. */
function persistableDraft(draft: ChannelDraft): ChannelDraft {
  const { origin: _origin, bodyUnavailable: _bodyUnavailable, ...rest } = draft;
  return rest;
}

const DRAFT_STORE: JsonStoreSpec<ChannelDraft> = {
  label: 'channel draft store',
  entriesKey: 'drafts',
  version: DRAFT_FILE_VERSION,
  parseEntry: parseDraft,
};

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

/** What each snapshot was read from, so its writer keeps the entries this version could not read. */
const snapshotSources = new WeakMap<ChannelDraftSnapshot, JsonStoreContents<ChannelDraft>>();

export function readChannelDrafts(shellPaths: ShellPaths): ChannelDraftSnapshot {
  const path = channelDraftFilePath(shellPaths);
  const contents = readJsonStore(path, DRAFT_STORE);
  const parseError = contents.unreadable
    ?? (contents.newerVersion === undefined ? undefined : `written by a newer GoodVibes (file version ${contents.newerVersion})`);
  const snapshot: ChannelDraftSnapshot = {
    path,
    exists: contents.exists,
    drafts: contents.entries,
    ...(parseError === undefined ? {} : { parseError }),
    ...(contents.keptAsFound.length > 0 ? { unreadableEntries: contents.keptAsFound.length } : {}),
  };
  snapshotSources.set(snapshot, contents);
  return snapshot;
}

/** A snapshot to write over. A file a newer build wrote is refused here, before any daemon call is built on it. */
function writableDraftSnapshot(paths: ShellPaths): ChannelDraftSnapshot {
  const snapshot = readChannelDrafts(paths);
  const contents = snapshotSources.get(snapshot);
  if (contents?.newerVersion !== undefined) {
    throw new Error(`The channel draft store at ${snapshot.path} was written by a newer GoodVibes (file version ${contents.newerVersion}), so no draft was changed. Update GoodVibes, then retry.`);
  }
  return snapshot;
}

/**
 * The drafts to keep when a write adds one past `DRAFT_LIMIT`: the oldest sent
 * drafts are dropped first. A write that would have to drop a draft not yet sent
 * is refused instead, with the count and how to make room.
 */
function outboxFull(unsent: number): Error {
  return new Error(`The draft outbox holds ${unsent} drafts that are not sent and keeps at most ${DRAFT_LIMIT}, so this draft was not saved and none was dropped. Send or delete some (agent_harness mode:"channel_drafts" lists them), then save again.`);
}

function boundDrafts(before: number, drafts: readonly ChannelDraft[]): { readonly kept: readonly ChannelDraft[]; readonly dropped: readonly ChannelDraft[] } {
  // Only a write that adds a draft is bounded; one that changes or removes a draft never drops another.
  if (drafts.length <= DRAFT_LIMIT || drafts.length <= before) return { kept: drafts, dropped: [] };
  const excess = drafts.length - DRAFT_LIMIT;
  const sentOldestFirst = drafts.filter((draft) => draft.status === 'sent').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (sentOldestFirst.length < excess) throw outboxFull(drafts.length - sentOldestFirst.length);
  const dropped = new Set(sentOldestFirst.slice(0, excess));
  return { kept: drafts.filter((draft) => !dropped.has(draft)), dropped: [...dropped] };
}

/**
 * Write `drafts` over the file `from` was read from, under the store lock the
 * caller holds; drafts this version cannot read are written back as found. The
 * caller's currency check runs once, right before the rename. Returns the sent
 * drafts the bound dropped, so their webhook secrets can go with them.
 */
function writeDrafts(from: ChannelDraftSnapshot, drafts: readonly ChannelDraft[], assertCurrent?: () => void,
  options: ChannelStoreEffectOptions = {}): readonly ChannelDraft[] {
  const path = from.path;
  const read = snapshotSources.get(from) ?? readJsonStore(path, DRAFT_STORE);
  const { kept, dropped } = boundDrafts(from.drafts.length, drafts);
  const contents = prepareJsonStoreWrite(read, DRAFT_STORE, { entries: kept.map(persistableDraft) }).text;
  const adoption = options.preparePublication?.(path, contents);
  writeStoreFile(path, contents, { ...(assertCurrent ? { assertCurrent } : {}), onEffect(published) {
    if (published) adoption?.();
  } });
  return dropped;
}

function generateDraftId(): string {
  return `draft-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const NOT_ATTEMPTED: ChannelDraftSyncOutcome = {
  synced: false,
  kind: 'not_attempted',
  error: 'no connected-host transport was supplied, so the daemon was not offered this draft',
};

/**
 * The daemon refuses a webhook URL (it is a bearer secret); it takes
 * `[redacted]` for it. The real value lives only in the secret store, where
 * delivery reads it. A `sent` or `failed` draft is offered with its outcome so
 * the other surfaces learn it.
 */
const REDACTED_WEBHOOK = '[redacted]';

/**
 * Offer a draft to the daemon's store, so other surfaces can see it.
 *
 * Manual callers use the native confirmation protocol. The admitted model
 * transport replaces that envelope with a request for fresh native admission.
 */
async function offerDraftToDaemon(
  invoke: DaemonOperatorInvoke | undefined,
  draft: ChannelDraft,
  options: ChannelStoreEffectOptions & { readonly historicalId?: string } = {},
): Promise<ChannelDraftSyncOutcome> {
  if (!invoke) return NOT_ATTEMPTED;
  const { daemonSyncState: _state, syncError: _error, origin: _origin, bodyUnavailable: _body, webhookSecretKey, ...wire } = draft;
  const wireBody = {
    ...wire,
    ...(wire.webhook === undefined && webhookSecretKey === undefined ? {} : { webhook: REDACTED_WEBHOOK }),
  };
  const offeredId = options.historicalId === undefined
    ? draft.wireReference ?? draft.id : historicalChannelDraftWireReference(options.historicalId);
  const result = await invoke(
    CHANNEL_DRAFTS_SAVE_METHOD,
    { ...wireBody, id: offeredId, confirm: true },
    { signal: options.signal, assertCurrent: options.assertCurrent, explicitUserRequest: options.explicitUserRequest ?? true },
  );
  if (!result.ok) return { synced: false, kind: result.kind, error: result.error };
  const body = isRecord(result.body) && isRecord(result.body.draft) ? result.body.draft : undefined;
  const canonical = body && typeof body.wireReference === 'string' ? body.wireReference
    : body && typeof body.id === 'string' && isNativeDraftWireReference(body.id) ? body.id
    : options.historicalId === undefined ? draft.wireReference : offeredId;
  const wireReference = canonical === undefined ? undefined : channelDraftWireReference(draft.id, canonical);
  return { synced: true, ...(wireReference === undefined ? {} : { wireReference }) };
}

function keepOrSet(input: string | undefined, existing: string | undefined): string | undefined {
  return input === undefined ? existing : input.trim() || undefined;
}

/**
 * Where a draft's webhook URL lives after a save. A URL is a bearer secret, so
 * a new one goes to the secret store and the draft file holds only the key; a
 * shell with no secret store refuses it rather than write the URL to the file.
 * A URL an older version wrote into the file is kept readable, and moves to the
 * secret store the first time a store is available.
 */
async function resolveDraftWebhook(
  id: string,
  supplied: string | undefined,
  existing: ChannelDraft | null,
  secrets: ChannelDraftWebhookSecrets | undefined,
): Promise<{ readonly secretKey?: string; readonly legacy?: string; /** A stored secret to delete once the draft no longer points at it. */ readonly discardKey?: string }> {
  const given = supplied?.trim();
  if (supplied !== undefined && !given) {
    // An explicit empty value removes the webhook.
    // Deleted by the caller after the draft is written: until then the stored
    // draft still points at it, and an abort must not leave it dangling.
    return existing?.webhookSecretKey ? { discardKey: existing.webhookSecretKey } : {};
  }
  const value = given || (secrets ? existing?.webhook : undefined);
  if (!value) {
    return {
      ...(existing?.webhookSecretKey ? { secretKey: existing.webhookSecretKey } : {}),
      ...(existing?.webhook ? { legacy: existing.webhook } : {}),
    };
  }
  if (!secrets) {
    throw new Error('A webhook URL is a bearer secret and is not written to the draft file, and this shell has no secret store to hold it, so the draft was not saved. Save the draft with a channel or route target instead.');
  }
  const secretKey = existing?.webhookSecretKey ?? `GOODVIBES_CHANNEL_DRAFT_WEBHOOK_${id.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;
  await secrets.set(secretKey, value);
  return { secretKey };
}

function withDraftSyncOutcome(draft: ChannelDraft, outcome: ChannelDraftSyncOutcome): ChannelDraft {
  if (outcome.synced) {
    const { syncError: _dropped, ...rest } = draft;
    return { ...rest, ...(outcome.wireReference === undefined ? {} : { wireReference: outcome.wireReference }), daemonSyncState: 'synced' };
  }
  return { ...draft, daemonSyncState: 'pending', syncError: outcome.error };
}

/**
 * Save a new draft or overwrite an existing draft by id.
 *
 * If `id` is provided in `input` and a draft with that id exists, it is
 * updated in-place (updatedAt refreshed). Otherwise a new draft is created.
 *
 * The daemon is offered the draft first, because a draft only reaches the
 * surface that finishes it if the daemon holds it. The local write happens
 * either way, the composition is the operator's work, and a daemon that could
 * not be reached is a reason to hold it, not to lose it.
 */
export async function saveDraft(
  shellPaths: ShellPaths,
  input: {
    readonly id?: string;
    readonly title?: string;
    readonly message: string;
    readonly channel?: string;
    readonly route?: string;
    readonly webhook?: string;
    readonly link?: string;
    readonly tags?: readonly string[];
    readonly status?: ChannelDraftStatus;
  },
  options: ChannelDraftStoreOptions = {},
): Promise<ChannelDraftSaveResult> {
  // Checked here, before the request leaves (inside the invoke) and before the rename: nowhere else.
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const message = input.message.trim();
  if (!message) throw new Error('Draft message is required.');

  const path = channelDraftFilePath(shellPaths);
  const assertCurrent = retainChannelStoreSource(path, options);
  const snapshot = writableDraftSnapshot(shellPaths);
  const now = new Date().toISOString();

  const existingIndex = input.id ? matchingDraftIndex(snapshot.drafts, input.id) : -1;
  const existing = existingIndex >= 0 ? snapshot.drafts[existingIndex] : null;
  // Refused before the daemon is offered it, so a draft that cannot be kept here is not kept there either.
  const unsent = snapshot.drafts.filter((draft) => draft.status !== 'sent').length;
  if (!existing && unsent >= DRAFT_LIMIT) throw outboxFull(unsent);

  // `sent` is final: saveDraft may set most statuses, but it must not undo one.
  if (existing?.status === 'sent' && input.status !== undefined && input.status !== 'sent') {
    const move = channelDraftLifecycle.check(existing.status, input.status);
    if (!move.ok) throw new Error(`Draft ${existing.id}: ${move.reason}. Nothing was changed; save the message as a new draft to send it again.`);
  }

  const id = existing?.id ?? generateDraftId();
  const status = input.status ?? existing?.status ?? 'draft';
  // Delivery targets are exclusive: supplying one replaces whichever was stored,
  // otherwise a retargeted draft would hold two and refuse to send.
  const supplies = (value: string | undefined): boolean => Boolean(value?.trim());
  const retargeting = supplies(input.channel) || supplies(input.route) || supplies(input.webhook) || supplies(input.link);
  const targetInput = (value: string | undefined): string | undefined => (retargeting && !supplies(value) ? '' : value);
  const webhook = await resolveDraftWebhook(id, targetInput(input.webhook), existing, options.webhookSecrets);
  // A field the caller leaves out keeps its stored value, so re-saving only the
  // text (as a retry hint or a model edit does) cannot strip a draft of its target.
  // An empty string clears the field.
  const title = keepOrSet(input.title, existing?.title);
  const channel = keepOrSet(targetInput(input.channel), existing?.channel);
  const route = keepOrSet(targetInput(input.route), existing?.route);
  const link = keepOrSet(targetInput(input.link), existing?.link);
  const tags = input.tags === undefined ? existing?.tags : input.tags.length > 0 ? input.tags : undefined;
  const drafted: ChannelDraft = {
    version: DRAFT_VERSION,
    id,
    wireReference: existing?.wireReference ?? createChannelDraftWireReference(id),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    status,
    message,
    ...(title ? { title } : {}),
    ...(channel ? { channel } : {}),
    ...(route ? { route } : {}),
    ...(webhook.legacy ? { webhook: webhook.legacy } : {}),
    ...(webhook.secretKey ? { webhookSecretKey: webhook.secretKey } : {}),
    ...(link ? { link } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(status === 'sent' && existing?.sentResponseId ? { sentResponseId: existing.sentResponseId } : {}),
    ...(status === 'failed' && existing?.sendError ? { sendError: existing.sendError } : {}),
  };

  const daemon = await offerDraftToDaemon(options.invoke, drafted, { ...options, assertCurrent,
    ...(existing && existing.wireReference === undefined ? { historicalId: existing.id } : {}) });
  const draft = withDraftSyncOutcome(drafted, daemon);

  // The daemon call above can take a while, and other writers use the file in
  // the meantime (a draft marked sent, saved or deleted). Merge this one draft
  // into the file as it is now rather than writing back the snapshot from before
  // the await, which would undo their changes.
  const { stored, dropped } = runStoreFileUpdateSync(path, () => {
    const fresh = writableDraftSnapshot(shellPaths);
    const freshIndex = fresh.drafts.findIndex((d) => d.id === id);
    const current = freshIndex >= 0 ? fresh.drafts[freshIndex]! : null;
    // A delivery recorded during the await is a fact; this save must not undo it.
    const merged: ChannelDraft = current?.status === 'sent' && draft.status !== 'sent'
      ? { ...draft, status: 'sent', ...(current.sentResponseId ? { sentResponseId: current.sentResponseId } : {}) }
      : draft;
    const updatedDrafts = freshIndex >= 0
      ? fresh.drafts.map((d, i) => (i === freshIndex ? merged : d))
      // Prepend new draft (most recent first)
      : [merged, ...fresh.drafts];
    return { stored: merged, dropped: writeDrafts(fresh, updatedDrafts, assertCurrent, options) };
  });
  // Secrets the drafts no longer reference; a leftover one is harmless, so a failed delete is not an error.
  const discard = [
    ...(webhook.discardKey && webhook.discardKey !== stored.webhookSecretKey ? [webhook.discardKey] : []),
    ...dropped.flatMap((gone) => gone.webhookSecretKey ? [gone.webhookSecretKey] : []),
  ];
  for (const key of discard) {
    try { await options.webhookSecrets?.delete?.(key); } catch { /* see above */ }
  }
  return { draft: stored, path, daemon };
}

/**
 * The daemon's drafts, when it will serve them.
 *
 * Returns null rather than an empty list when the daemon does not answer: an
 * empty list would read as "no drafts anywhere" and hide the ones the local
 * mirror is holding.
 */
export async function fetchDaemonDrafts(
  invoke: DaemonOperatorInvoke,
  options: { readonly status?: ChannelDraftStatus; readonly limit?: number } = {},
): Promise<{ readonly drafts: readonly ChannelDraft[]; /** How many drafts the daemon holds for this filter, which can exceed `drafts`. */ readonly total: number } | { readonly error: string; readonly kind: DaemonInvokeFailureKind }> {
  const result = await invoke(CHANNEL_DRAFTS_LIST_METHOD, {
    ...(options.status ? { status: options.status } : {}),
    ...(typeof options.limit === 'number' ? { limit: Math.min(Math.max(1, Math.floor(options.limit)), DAEMON_DRAFT_LIST_MAX) } : {}),
  });
  if (!result.ok) return { error: result.error, kind: result.kind };
  if (!isRecord(result.body) || !Array.isArray(result.body.drafts)) {
    return { error: `${CHANNEL_DRAFTS_LIST_METHOD} answered without a drafts array`, kind: 'connected_host_error' };
  }
  const drafts = (result.body.drafts as unknown[])
    .map(parseDraft)
    .filter((d): d is ChannelDraft => d !== null)
    .map((d) => ({ ...d, daemonSyncState: 'synced' as const, origin: 'daemon' as const }));
  const reported = isRecord(result.body) ? result.body.total : undefined;
  return { drafts, total: typeof reported === 'number' && Number.isFinite(reported) ? Math.max(reported, drafts.length) : drafts.length };
}

/**
 * One draft the daemon holds, looked up by id or wire reference, whatever the
 * size of its list. `null` means the daemon answered that it has no such draft.
 */
export async function fetchDaemonDraft(
  invoke: DaemonOperatorInvoke,
  draftId: string,
): Promise<{ readonly draft: ChannelDraft | null } | { readonly error: string; readonly kind: DaemonInvokeFailureKind }> {
  const result = await invoke(CHANNEL_DRAFTS_GET_METHOD, { draftId });
  if (!result.ok) return { error: result.error, kind: result.kind };
  if (!isRecord(result.body) || result.body.notFound === true) return { draft: null };
  const parsed = parseDraft(result.body);
  if (!parsed) return { draft: null };
  // The daemon serves the text to its owner; any other caller gets the marker.
  const readable = parsed.message !== '[redacted]';
  return { draft: { ...parsed, daemonSyncState: 'synced' as const, origin: 'daemon' as const, ...(readable ? {} : { bodyUnavailable: true as const }) } };
}

/**
 * Bring a draft only the daemon holds into this outbox, so it can be sent from
 * here: "the phone writes it, the terminal sends it". Null when the daemon has
 * no such draft. Refused, with the step that works, when the daemon would not
 * serve its text or it sends to a webhook whose URL stays with the surface that
 * composed it.
 */
export async function adoptDaemonDraft(
  shellPaths: ShellPaths,
  draftId: string,
  options: ChannelDraftStoreOptions,
): Promise<ChannelDraft | null> {
  if (!options.invoke) return null;
  const fetched = await fetchDaemonDraft(options.invoke, draftId);
  if (!('draft' in fetched)) throw new Error(`Draft ${draftId} is not in this outbox and the daemon could not be asked for it: ${fetched.error}`);
  const held = fetched.draft;
  if (!held) return null;
  if (held.bodyUnavailable) {
    throw new Error(`Draft ${draftId} is on the daemon, which serves its text only to the owner's credential; nothing was sent. Connect this Agent with the owner's pairing, or send it from the surface that composed it.`);
  }
  if (held.webhook || held.webhookSecretKey) {
    throw new Error(`Draft ${draftId} sends to a webhook whose URL stays with the surface that composed it; nothing was sent. Send it from there, or save it here again with its webhook.`);
  }
  const path = channelDraftFilePath(shellPaths);
  const assertCurrent = retainChannelStoreSource(path, options);
  const { origin: _origin, bodyUnavailable: _body, ...rest } = held;
  const adopted: ChannelDraft = { ...rest, daemonSyncState: 'synced' };
  const { draft, dropped } = runStoreFileUpdateSync(path, () => {
    const fresh = writableDraftSnapshot(shellPaths);
    const index = matchingDraftIndex(fresh.drafts, draftId);
    if (index >= 0) return { draft: fresh.drafts[index]!, dropped: [] };
    return { draft: adopted, dropped: writeDrafts(fresh, [adopted, ...fresh.drafts], assertCurrent, options) };
  });
  for (const gone of dropped) {
    if (gone.webhookSecretKey) { try { await options.webhookSecrets?.delete?.(gone.webhookSecretKey); } catch { /* nothing refers to it any more */ } }
  }
  return draft;
}

/**
 * One list from two stores.
 *
 * The daemon's list carries no text (it answers `[redacted]`) and may not have
 * learned a delivery outcome yet, so for an id both stores hold, this outbox's
 * text, status and delivery outcome are the true ones: only the daemon's
 * identity, update time and sync state are taken from it. A draft only the
 * daemon has is listed with `bodyUnavailable`: its text is one `get` away
 * (`fetchDaemonDraft`), and sending it brings it into this outbox
 * (`adoptDaemonDraft`). A draft only this outbox has is kept and shown as
 * pending, because that is exactly the draft an operator would otherwise think
 * they had lost.
 */
export function mergeDraftViews(
  daemonDrafts: readonly ChannelDraft[],
  localDrafts: readonly ChannelDraft[],
): readonly ChannelDraft[] {
  const byId = new Map<string, ChannelDraft>();
  for (const draft of localDrafts) byId.set(draft.wireReference ?? draft.id, { ...draft, origin: 'local' });
  for (const draft of daemonDrafts) {
    const key = draft.wireReference ?? draft.id;
    const local = byId.get(key);
    if (local) {
      byId.set(key, {
        ...local,
        ...(draft.wireReference === undefined ? {} : { wireReference: draft.wireReference }),
        updatedAt: draft.updatedAt > local.updatedAt ? draft.updatedAt : local.updatedAt,
        daemonSyncState: 'synced',
      });
    } else {
      byId.set(key, { ...draft, bodyUnavailable: true });
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** List all drafts, optionally filtered by status. */
export function listDrafts(
  shellPaths: ShellPaths,
  options: { readonly status?: ChannelDraftStatus; readonly limit?: number } = {},
): ChannelDraftSnapshot {
  const snapshot = readChannelDrafts(shellPaths);
  let drafts = snapshot.drafts;
  if (options.status) {
    drafts = drafts.filter((d) => d.status === options.status);
  }
  if (typeof options.limit === 'number' && options.limit > 0) {
    drafts = drafts.slice(0, options.limit);
  }
  return { ...snapshot, drafts };
}

/** Resolve only actual stored rows; a legacy handle cannot choose an ambiguous row. */
function matchingDraftIndex(drafts: readonly ChannelDraft[], requestedId: string): number {
  const matches = drafts.flatMap((draft, index) => draft.id === requestedId || draft.wireReference === requestedId
    || (draft.wireReference === undefined || draft.wireReference !== draft.id)
      && matchesHistoricalDraftWireReference(draft.id, requestedId) ? [index] : []);
  if (matches.length > 1) throw new ToolInputProjectionError('held');
  return matches[0] ?? -1;
}

/** Get a single draft by id. Returns null if not found. */
export function getDraft(shellPaths: ShellPaths, draftId: string): ChannelDraft | null {
  const snapshot = readChannelDrafts(shellPaths);
  return snapshot.drafts[matchingDraftIndex(snapshot.drafts, draftId)] ?? null;
}

/**
 * Delete a draft by id, here and in the daemon's store.
 *
 * The local copy goes even when the daemon refuses. A delete the operator asked
 * for that half-happens is confusing in one direction only: the draft
 * reappearing on this surface after they deleted it is worse than it lingering
 * on another until the next sync. The daemon's answer is reported either way,
 * so a caller can say which happened.
 */
export async function deleteDraft(
  shellPaths: ShellPaths,
  draftId: string,
  options: { readonly invoke?: DaemonOperatorInvoke; readonly webhookSecrets?: ChannelDraftWebhookSecrets } = {},
): Promise<ChannelDraftDeleteResult> {
  const initial = writableDraftSnapshot(shellPaths);
  const selected = initial.drafts[matchingDraftIndex(initial.drafts, draftId)];
  const reference = options.invoke && selected ? selected.wireReference ?? historicalChannelDraftWireReference(selected.id) : draftId;
  const daemon: ChannelDraftSyncOutcome = options.invoke
    ? await (async () => {
        const result = await options.invoke!(
          CHANNEL_DRAFTS_DELETE_METHOD,
          { draftId: reference, confirm: true },
          { explicitUserRequest: true },
        );
        return result.ok
          ? { synced: true as const }
          : { synced: false as const, kind: result.kind, error: result.error };
      })()
    : NOT_ATTEMPTED;

  const path = channelDraftFilePath(shellPaths);
  const deleted = runStoreFileUpdateSync(path, () => {
    const snapshot = writableDraftSnapshot(shellPaths);
    const before = snapshot.drafts.length;
    const selectedIndex = matchingDraftIndex(snapshot.drafts, draftId);
    const updated = snapshot.drafts.filter((_d, index) => index !== selectedIndex);
    if (updated.length === before) return false;
    writeDrafts(snapshot, updated);
    return true;
  });
  // The webhook URL goes with the draft; a store that will not delete it leaves a secret
  // nothing refers to, which is better than failing a delete the operator asked for.
  if (deleted && selected?.webhookSecretKey) await options.webhookSecrets?.delete?.(selected.webhookSecretKey).catch(() => undefined);
  return { deleted, daemon };
}

export interface ChannelDraftSyncReport {
  readonly attempted: number;
  readonly synced: number;
  readonly refused: number;
}

/**
 * Offer the drafts the daemon does not hold, or only `draftId` when given.
 *
 * The retry for drafts composed while the daemon was unreachable, a delivery
 * outcome the daemon has not heard yet, and the migration for drafts written
 * before the daemon held this store: a draft the daemon does not have in its
 * current state, offered to it. A `sent` or `failed` draft is offered with its
 * outcome. `channel_draft_send` calls this for the draft it just settled; the
 * other pending drafts are re-offered by saving them again. This is the store
 * syncing itself, not a person asking, so the explicit-user-request claim is not made.
 */
export async function syncChannelDrafts(
  shellPaths: ShellPaths,
  invoke: DaemonOperatorInvoke,
  options: ChannelStoreEffectOptions & { readonly draftId?: string } = {},
): Promise<ChannelDraftSyncReport> {
  const snapshot = writableDraftSnapshot(shellPaths);
  const only = options.draftId === undefined ? -1 : matchingDraftIndex(snapshot.drafts, options.draftId);
  const pending = snapshot.drafts.filter((draft, index) => draft.daemonSyncState !== 'synced' && (options.draftId === undefined || index === only));
  if (pending.length === 0) return { attempted: 0, synced: 0, refused: 0 };

  const updatedById = new Map<string, { readonly offered: ChannelDraft; readonly outcome: ChannelDraftSyncOutcome }>();
  let synced = 0;
  let refused = 0;
  for (const draft of pending) {
    const outcome = await offerDraftToDaemon(invoke, draft, {
      explicitUserRequest: false,
      signal: options.signal,
      assertCurrent: options.assertCurrent,
      ...(draft.wireReference === undefined ? { historicalId: draft.id } : {}),
    });
    updatedById.set(draft.id, { offered: draft, outcome });
    if (outcome.synced) synced += 1;
    else refused += 1;
  }
  // Apply each outcome to the file as it is after the awaits. A draft that was
  // deleted, or saved again with other content, while the daemon was answering
  // is left as its writer left it: the outcome describes the copy that was offered.
  const path = channelDraftFilePath(shellPaths);
  runStoreFileUpdateSync(path, () => {
    const fresh = writableDraftSnapshot(shellPaths);
    writeDrafts(fresh, fresh.drafts.map((draft) => {
      const result = updatedById.get(draft.id);
      return result && result.offered.updatedAt === draft.updatedAt && result.offered.status === draft.status
        ? withDraftSyncOutcome(draft, result.outcome)
        : draft;
    }), options.assertCurrent, options);
  });
  return { attempted: pending.length, synced, refused };
}

/** Draft ids being promoted to 'queued' in this process; see queueDraftToSend. */
const queueingDraftIds = new Set<string>();

/**
 * Promote a draft to 'queued' status and return an AgentChannelDeliveryInput
 * ready to pass to `deliverAgentChannelMessage`.
 *
 * The draft is updated to status 'queued'. The caller is responsible for
 * calling `deliverAgentChannelMessage` and then `markDraftSent` or
 * `markDraftFailed` to record the outcome.
 *
 * This routes through the EXISTING confirmed send path, no new platform contract.
 */
export async function queueDraftToSend(
  shellPaths: ShellPaths,
  draftId: string,
  options: ChannelDraftStoreOptions = {},
  /**
   * Decides whether this delivery may happen, given exactly what would be sent.
   * It runs before the draft is marked queued: a refusal throws and leaves the
   * draft as it was, so a held send is never recorded as a delivery attempt.
   */
  admit?: (deliveryInput: AgentChannelDeliveryInput) => Promise<void>,
): Promise<ChannelDraftQueueResult> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  // A draft written on another surface is on the daemon, the store of record.
  const draft = getDraft(shellPaths, draftId) ?? await adoptDaemonDraft(shellPaths, draftId, options);
  if (!draft) throw new Error(`Draft not found: ${draftId}`);
  if (draft.status === 'sent') throw new Error(`Draft ${draftId} is already sent.`);
  const move = channelDraftLifecycle.check(draft.status, 'queued');
  if (!move.ok) {
    // Queued is written before delivery starts, so a queued draft is in flight
    // or was handed to delivery with no outcome recorded (the sender exited, or
    // the receipt could not be written). Either way it may have been delivered.
    throw new Error(draft.status === 'queued'
      ? `Draft ${draftId} was handed to delivery at ${draft.updatedAt} and no outcome is recorded, so it may already have been delivered; it is not sent again. `
        + 'If the recipient did not get it, save its text as a new draft (agent_harness mode:"channel_draft_save" without draftId) and send that.'
      : `Draft ${draftId}: ${move.reason}.`);
  }

  // The status check above and the 'queued' write below are separated by the
  // daemon call, so a second overlapping call would pass the same check and
  // deliver the draft twice. Claim the draft here, with no await between the
  // check and the claim.
  if (queueingDraftIds.has(draft.id)) throw new Error(`Draft ${draftId} is already being queued for delivery by another call, so this one sent nothing. Wait for that send to finish, then check the draft's status.`);
  queueingDraftIds.add(draft.id);
  try {
    return await promoteDraftToQueued(shellPaths, draft, draftId, options, admit);
  } finally {
    queueingDraftIds.delete(draft.id);
  }
}

async function promoteDraftToQueued(
  shellPaths: ShellPaths,
  draft: ChannelDraft,
  draftId: string,
  options: ChannelDraftStoreOptions,
  admit: ((deliveryInput: AgentChannelDeliveryInput) => Promise<void>) | undefined,
): Promise<ChannelDraftQueueResult> {
  let webhook = draft.webhook;
  if (!webhook && draft.webhookSecretKey) {
    webhook = (await options.webhookSecrets?.get(draft.webhookSecretKey)) ?? undefined;
    if (!webhook) {
      throw new Error(`Draft ${draftId} sends to a webhook whose URL is kept in the secret store (${draft.webhookSecretKey}) and it could not be read, so nothing was sent. Save the draft again with its webhook to restore it.`);
    }
  }
  const deliveryInput: AgentChannelDeliveryInput = {
    message: draft.message,
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.channel ? { channel: draft.channel } : {}),
    ...(draft.route ? { route: draft.route } : {}),
    ...(webhook ? { webhook } : {}),
    ...(draft.link ? { link: draft.link } : {}),
  };

  if (admit) await admit(deliveryInput);

  // The webhook is not passed back in: the save keeps the stored one, and the
  // URL stays out of the draft file.
  const { webhook: _webhook, ...saveFields } = deliveryInput;
  const queuedDraft = (await saveDraft(
    shellPaths,
    {
      id: draft.id,
      ...saveFields,
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.tags ? { tags: draft.tags } : {}),
      status: 'queued',
    },
    options,
  )).draft;

  return { draftId, deliveryInput, draft: queuedDraft };
}

/**
 * Mark a draft as successfully sent. Records the response id from the delivery.
 */
export function markDraftSent(
  shellPaths: ShellPaths,
  draftId: string,
  responseId?: string,
  options: ChannelStoreEffectOptions = {},
): ChannelDraft {
  const path = channelDraftFilePath(shellPaths);
  const assertCurrent = retainChannelStoreSource(path, options);
  return runStoreFileUpdateSync(path, () => {
    const snapshot = writableDraftSnapshot(shellPaths);
    const existing = snapshot.drafts[matchingDraftIndex(snapshot.drafts, draftId)];
    if (!existing) throw new Error(`Draft not found: ${draftId}`);
    const move = channelDraftLifecycle.check(existing.status, 'sent');
    if (!move.ok) throw new Error(`Draft ${draftId}: ${move.reason}.`);
    const now = new Date().toISOString();
    const patched: ChannelDraft = {
      ...existing,
      updatedAt: now,
      status: 'sent',
      daemonSyncState: 'pending',
      ...(responseId ? { sentResponseId: responseId } : {}),
    };
    const updatedDrafts = snapshot.drafts.map((d) => (d.id === existing.id ? patched : d));
    writeDrafts(snapshot, updatedDrafts, assertCurrent, options);
    return patched;
  });
}

/**
 * Mark a draft as failed to send. Records the error message.
 */
export function markDraftFailed(
  shellPaths: ShellPaths,
  draftId: string,
  error: string,
  options: ChannelStoreEffectOptions = {},
): ChannelDraft {
  const path = channelDraftFilePath(shellPaths);
  const assertCurrent = retainChannelStoreSource(path, options);
  return runStoreFileUpdateSync(path, () => {
    const snapshot = writableDraftSnapshot(shellPaths);
    const existing = snapshot.drafts[matchingDraftIndex(snapshot.drafts, draftId)];
    if (!existing) throw new Error(`Draft not found: ${draftId}`);
    const move = channelDraftLifecycle.check(existing.status, 'failed');
    if (!move.ok) throw new Error(`Draft ${draftId}: ${move.reason}.`);
    const now = new Date().toISOString();
    const patched: ChannelDraft = {
      ...existing,
      updatedAt: now,
      status: 'failed',
      daemonSyncState: 'pending',
      sendError: error,
    };
    const updatedDrafts = snapshot.drafts.map((d) => (d.id === existing.id ? patched : d));
    writeDrafts(snapshot, updatedDrafts, assertCurrent, options);
    return patched;
  });
}

/** Format a single draft for human-readable display. */
export function formatChannelDraft(draft: ChannelDraft): string {
  const targetPart = draft.channel
    ? `channel=${draft.channel}`
    : draft.route
      ? `route=${draft.route}`
      : draft.webhook || draft.webhookSecretKey
        ? 'webhook=[redacted]'
        : draft.link
          ? `link=${draft.link}`
          : 'no-target';
  const lines = [
    `draft ${draft.id}`,
    `  status: ${draft.status}`,
    `  target: ${targetPart}`,
    ...(draft.title ? [`  title: ${draft.title}`] : []),
    `  message: ${draft.message.length} chars`,
    `  created: ${draft.createdAt}  updated: ${draft.updatedAt}`,
    ...(draft.tags && draft.tags.length > 0 ? [`  tags: ${draft.tags.join(', ')}`] : []),
    ...(draft.sentResponseId ? [`  sent response: ${draft.sentResponseId}`] : []),
    ...(draft.sendError ? [`  error: ${draft.sendError}`] : []),
  ];
  return lines.join('\n');
}

/** Format the draft list summary. */
export function formatChannelDraftList(snapshot: ChannelDraftSnapshot): string {
  const lines = [
    'Channel Drafts',
    `  path: ${snapshot.path}`,
    `  total: ${snapshot.drafts.length}`,
    `  status: ${snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty'}`,
    ...(snapshot.parseError ? [`  parse error: ${snapshot.parseError}`] : []),
    ...(snapshot.unreadableEntries ? [`  kept as found: ${snapshot.unreadableEntries} stored draft${snapshot.unreadableEntries === 1 ? '' : 's'} this version cannot read`] : []),
    '  policy: the daemon holds the drafts; this file is the outbox for ones it has not taken yet. Sends require queueDraftToSend + deliverAgentChannelMessage with explicit user confirmation',
    '',
  ];
  if (snapshot.drafts.length === 0) {
    lines.push('  no drafts');
  } else {
    for (const draft of snapshot.drafts) {
      const targetPart = draft.channel ?? draft.route ?? (draft.webhook || draft.webhookSecretKey ? 'webhook=[redacted]' : null) ?? draft.link ?? 'no-target';
      const preview = draft.bodyUnavailable ? '(text on the daemon; open the draft to read it)' : `${draft.message.slice(0, 60)}${draft.message.length > 60 ? '...' : ''}`;
      lines.push(`  [${draft.status}] ${draft.id}  target=${targetPart}  ${preview}`);
    }
  }
  return lines.join('\n');
}

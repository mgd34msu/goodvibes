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
 * daemon's, `channels.drafts.*`, and this file is a mirror, for the same
 * reason the routing table has one: a draft composed while the daemon was
 * unreachable is work the operator did, and losing it because a peer was busy
 * would be worse than holding it. A held draft says `pending` and carries the
 * daemon's own words.
 *
 * Sends always route through the EXISTING `deliverAgentChannelMessage` path
 * (which wraps `ChannelDeliveryRouter.deliver` via the agent_channel_send
 * confirm pattern). Adopting the daemon's draft STORE does not move where a
 * send happens.
 *
 * Persistence: JSON file at {agentRoot}/channels/drafts.json via ShellPathService.
 */

import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { channelDraftWireReference, createChannelDraftWireReference, historicalChannelDraftWireReference, isNativeDraftWireReference, matchesHistoricalDraftWireReference } from '@goodvibes-jev/engine/platform/platform/channels';
import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { runStoreFileUpdateSync, writeStoreFile } from '@/utils/store-file.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { retainChannelStoreSource, type ChannelStoreEffectOptions } from './channel-store-lifetime.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { AgentChannelDeliveryInput } from './channel-delivery.ts';
import { defineLifecycle } from '@goodvibes-jev/engine/platform/platform/utils';
import type { DaemonInvokeFailureKind, DaemonOperatorInvoke } from './daemon-operator-client.ts';

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
 * delivery input only on a move into 'queued', so an already queued draft
 * cannot be sent twice. 'sent' is final. A failed delivery may be queued again
 * as a retry. (saveDraft edits a draft's content and may set any status; this
 * table governs the send-path writers.)
 */
/** How long a draft may sit queued with no recorded outcome before it counts as abandoned and may be queued again. */
export const ABANDONED_QUEUE_MS = 10 * 60_000;

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
  /** The daemon never returns a draft's text, so a row only it holds has none to show. Never persisted. */
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

interface ChannelDraftFile {
  readonly version: 1;
  readonly drafts: readonly ChannelDraft[];
}

type ShellPaths = Pick<ShellPathService, 'resolveUserPath'>;

const DRAFT_VERSION = 1 as const;
const DRAFT_FILE_VERSION = 1 as const;
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

function parseDraftFile(raw: unknown): ChannelDraftFile {
  if (!isRecord(raw)) return { version: DRAFT_FILE_VERSION, drafts: [] };
  const drafts = Array.isArray(raw.drafts)
    ? raw.drafts.map(parseDraft).filter((d): d is ChannelDraft => d !== null)
    : [];
  return { version: DRAFT_FILE_VERSION, drafts };
}

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

export function readChannelDrafts(shellPaths: ShellPaths): ChannelDraftSnapshot {
  const path = channelDraftFilePath(shellPaths);
  if (!existsSync(path)) return { path, exists: false, drafts: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(parsed) || parsed.version !== DRAFT_FILE_VERSION || !Array.isArray(parsed.drafts)) throw new Error('Unsupported draft file');
    return { path, exists: true, drafts: parseDraftFile(parsed).drafts };
  } catch (error) {
    return {
      path,
      exists: true,
      drafts: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function writableDraftSnapshot(paths: ShellPaths): ChannelDraftSnapshot {
  const snapshot = readChannelDrafts(paths);
  if (snapshot.parseError !== undefined) throw new ToolInputProjectionError('held');
  return snapshot;
}

function writeDrafts(path: string, drafts: readonly ChannelDraft[], assertCurrent?: () => void,
  options: ChannelStoreEffectOptions = {}): void {
  const file: ChannelDraftFile = {
    version: DRAFT_FILE_VERSION,
    drafts: drafts.slice(0, DRAFT_LIMIT).map(persistableDraft),
  };
  const contents = `${JSON.stringify(file, null, 2)}\n`, prepare = options.preparePublication;
  assertCurrent?.();
  const adoption = prepare?.(path, contents);
  if (prepare && typeof adoption !== 'function') throw new ToolInputProjectionError('held');
  const assertOwner = () => {
    if (options.preparePublication !== prepare) throw new ToolInputProjectionError('stale');
    assertCurrent?.();
  };
  writeStoreFile(path, contents, { assertCurrent: assertOwner, onEffect(published) {
    if (!published) return;
    if (options.preparePublication !== prepare) throw new ToolInputProjectionError('stale');
    const outcome: unknown = adoption?.();
    if (outcome !== undefined) throw new ToolInputProjectionError('held');
  } });
}

function generateDraftId(): string {
  return `draft-${opaqueUuid()}`;
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
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const message = input.message.trim();
  if (!message) throw new Error('Draft message is required.');

  const path = channelDraftFilePath(shellPaths);
  const assertCurrent = retainChannelStoreSource(path, options);
  const snapshot = writableDraftSnapshot(shellPaths);
  const now = new Date().toISOString();

  const existingIndex = input.id ? matchingDraftIndex(snapshot.drafts, input.id) : -1;
  const existing = existingIndex >= 0 ? snapshot.drafts[existingIndex] : null;

  // `sent` is final: saveDraft may set most statuses, but it must not undo one.
  if (existing?.status === 'sent' && input.status !== undefined && input.status !== 'sent') {
    const move = channelDraftLifecycle.check(existing.status, input.status);
    if (!move.ok) throw new Error(`Draft ${existing.id}: ${move.reason}.`);
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
  assertCurrent();
  const draft = withDraftSyncOutcome(drafted, daemon);

  // The daemon call above can take a while, and other writers use the file in
  // the meantime (a draft marked sent, saved or deleted). Merge this one draft
  // into the file as it is now rather than writing back the snapshot from before
  // the await, which would undo their changes.
  const stored = runStoreFileUpdateSync(path, () => {
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
    writeDrafts(path, updatedDrafts, assertCurrent, options);
    return merged;
  });
  if (webhook.discardKey && webhook.discardKey !== stored.webhookSecretKey) {
    try { await options.webhookSecrets?.delete?.(webhook.discardKey); } catch { /* the draft no longer references it; a leftover secret is harmless */ }
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
  return { draft: parsed ? { ...parsed, daemonSyncState: 'synced' as const, origin: 'daemon' as const } : null };
}

/**
 * One list from two stores.
 *
 * The daemon never returns a draft's text (it answers `[redacted]`) and may not
 * have learned a delivery outcome yet, so for an id both stores hold, this
 * mirror's text, status and delivery outcome are the true ones: only the daemon's identity,
 * update time and sync state are taken from it. A draft only the daemon has is
 * listed with `bodyUnavailable`, since its text cannot be read back through this
 * API. A draft only the local mirror has is kept and shown as pending, because
 * that is exactly the draft an operator would otherwise think they had lost.
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
    writeDrafts(path, updated);
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
    writeDrafts(path, fresh.drafts.map((draft) => {
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
): Promise<ChannelDraftQueueResult> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const draft = getDraft(shellPaths, draftId);
  if (!draft) throw new Error(`Draft not found: ${draftId}`);
  if (draft.status === 'sent') throw new Error(`Draft ${draftId} is already sent.`);
  // A draft still queued long after it was handed to delivery was abandoned by
  // a process that exited before recording an outcome. Without this it could
  // never be sent: let it be queued again once it is clearly not in flight.
  const abandoned = draft.status === 'queued' && Date.now() - Date.parse(draft.updatedAt) >= ABANDONED_QUEUE_MS;
  const move = channelDraftLifecycle.check(draft.status, 'queued');
  if (!move.ok && !abandoned) {
    throw new Error(draft.status === 'queued'
      ? `Draft ${draftId} is already queued and being delivered; it can be queued again if no outcome is recorded within ${ABANDONED_QUEUE_MS / 60_000} minutes.`
      : `Draft ${draftId}: ${move.reason}.`);
  }

  // The status check above and the 'queued' write below are separated by the
  // daemon call, so a second overlapping call would pass the same check and
  // deliver the draft twice. Claim the draft here, with no await between the
  // check and the claim.
  if (queueingDraftIds.has(draft.id)) throw new Error(`Draft ${draftId} is already being queued for delivery.`);
  queueingDraftIds.add(draft.id);
  try {
    return await promoteDraftToQueued(shellPaths, draft, draftId, options);
  } finally {
    queueingDraftIds.delete(draft.id);
  }
}

async function promoteDraftToQueued(
  shellPaths: ShellPaths,
  draft: ChannelDraft,
  draftId: string,
  options: ChannelDraftStoreOptions,
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
    writeDrafts(path, updatedDrafts, assertCurrent, options);
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
    writeDrafts(path, updatedDrafts, assertCurrent, options);
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
    '  policy: drafts are agent-local; sends require queueDraftToSend + deliverAgentChannelMessage with explicit user confirmation',
    '',
  ];
  if (snapshot.drafts.length === 0) {
    lines.push('  no drafts');
  } else {
    for (const draft of snapshot.drafts) {
      const targetPart = draft.channel ?? draft.route ?? (draft.webhook || draft.webhookSecretKey ? 'webhook=[redacted]' : null) ?? draft.link ?? 'no-target';
      const preview = draft.bodyUnavailable ? '(text held on the daemon, not readable here)' : `${draft.message.slice(0, 60)}${draft.message.length > 60 ? '...' : ''}`;
      lines.push(`  [${draft.status}] ${draft.id}  target=${targetPart}  ${preview}`);
    }
  }
  return lines.join('\n');
}

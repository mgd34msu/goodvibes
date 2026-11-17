/**
 * channels.drafts.* handler surface: the store of record for channel drafts.
 *
 * Attaches host handlers to the four platform-registered builtin descriptors:
 *   channels.drafts.list    read:channels      metadata only
 *   channels.drafts.get     read:channels      one draft; its text for the owner
 *   channels.drafts.save    write:channels     access:admin, confirm-gated
 *   channels.drafts.delete  write:channels     access:admin, dangerous, confirm-gated
 *
 * The platform owns every id, descriptor, access flag, and I/O schema (auto-
 * registered with handler:undefined). This module NEVER re-declares any of
 * them, it looks each up via catalog.get(id) (inside registerCatalogHandler)
 * and re-registers with the wrapped handler. Manual save/delete retain explicit
 * confirmation. A call made with the Agent's credential goes through `runNativeMutation`, which
 * checks the paired owner; its write is a compare-and-set on the row it read.
 *
 * SECURITY: the message body is encrypted at rest. `list` answers a fixed
 * redaction marker for it; `get` decrypts it for an owner (admin) caller, the
 * principal that can already send any text through the channel, so a draft
 * written on one device can be read and sent from another. Webhooks are
 * encrypted at rest and ALWAYS redacted on read; RAW webhook tokens submitted
 * to save are REJECTED, the agent must redact ('[redacted]') or pass a
 * goodvibes://secrets/ reference before transmission.
 */
import type { DraftHostContext as HandlerContext } from './types.js';
import { createAtRestCipher } from '../../config/daemon-credential-store.js';
import { HandlerError } from '../../control-plane/host-handlers.js';
import { registerCatalogHandlers } from '../../control-plane/host-handlers.js';
import { assertConfirmed } from '../../control-plane/host-handlers.js';
import { isDelegatedCaller, runNativeMutation } from '../../control-plane/native-mutation.js';
import type { TypedHandler } from '../../control-plane/host-handlers.js';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { channelDraftWireReference, isNativeDraftWireReference } from './wire-reference.js';
import {
  ALL_DRAFT_STATUSES,
  DraftSyncStore,
  MAX_DRAFT_LIST_LIMIT,
  WRITABLE_DRAFT_STATUSES,
} from './draft-store.js';
import type {
  DraftListQuery,
  DraftRecord,
  DraftSaveInput,
  DraftStatus,
} from './draft-store.js';

const BAD_INPUT = 'INVALID_INPUT';

const LIST_ID = 'channels.drafts.list';
const GET_ID = 'channels.drafts.get';
const SAVE_ID = 'channels.drafts.save';
const DELETE_ID = 'channels.drafts.delete';

const writableStatusSet = new Set<string>(WRITABLE_DRAFT_STATUSES);
const allStatusSet = new Set<string>(ALL_DRAFT_STATUSES);

// --- Input validation helpers ----------------------------------------------

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HandlerError('Request body must be an object.', BAD_INPUT, 400);
  }
  return body as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HandlerError(`Field '${field}' must be a string.`, BAD_INPUT, 400);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  const str = optionalString(value, field);
  if (str === undefined || str.length === 0) {
    throw new HandlerError(`Field '${field}' is required.`, BAD_INPUT, 400);
  }
  return str;
}

function optionalTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new HandlerError("Field 'tags' must be an array of strings.", BAD_INPUT, 400);
  }
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new HandlerError("Field 'tags' must contain only strings.", BAD_INPUT, 400);
    }
    tags.push(entry);
  }
  return tags;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HandlerError("Field 'limit' must be an integer.", BAD_INPUT, 400);
  }
  if (value < 1 || value > MAX_DRAFT_LIST_LIMIT) {
    throw new HandlerError(
      `Field 'limit' must be between 1 and ${MAX_DRAFT_LIST_LIMIT}.`,
      BAD_INPUT,
      400,
    );
  }
  return value;
}

function optionalVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HandlerError("Field 'version' must be a positive integer.", BAD_INPUT, 400);
  }
  return value;
}

// Strict ISO-8601 date-time. Anchored so loosely-formatted but Date.parse-able
// values (e.g. '2020', 'Jan 1 2020', '2020-1-1') are rejected.
const ISO_8601_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function optionalIso8601(value: unknown, field: string): string | undefined {
  const str = optionalString(value, field);
  if (str === undefined) return undefined;
  const time = ISO_8601_DATE_TIME.test(str) ? Date.parse(str) : Number.NaN;
  if (Number.isNaN(time)) {
    throw new HandlerError(`Field '${field}' must be an ISO-8601 timestamp.`, BAD_INPUT, 400);
  }
  return new Date(time).toISOString();
}

/**
 * Reject RAW webhook tokens submitted to save. The contract requires webhooks
 * to be redacted before transmission; the daemon only stores '[redacted]' or a
 * goodvibes://secrets/ reference (which carries no token material). Any other
 * value bearing a scheme (e.g. an https:// URL with an embedded token) is a raw
 * secret and is rejected outright, never persisted, never logged.
 */
function validateWebhook(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === '' || value === '[redacted]') return value;
  if (value.startsWith('goodvibes://secrets/')) return value;
  if (value.includes('://')) {
    throw new HandlerError(
      "Field 'webhook' must be redacted before transmission: pass '[redacted]' "
        + 'or a goodvibes://secrets/ reference, never a raw webhook URL.',
      'WEBHOOK_REDACTION_REQUIRED',
      400,
    );
  }
  return value;
}

function parseListStatus(value: unknown): DraftStatus | undefined {
  const str = optionalString(value, 'status');
  if (str === undefined) return undefined;
  if (!allStatusSet.has(str)) {
    throw new HandlerError(
      `Field 'status' must be one of: ${ALL_DRAFT_STATUSES.join(', ')}.`,
      BAD_INPUT,
      400,
    );
  }
  return str as DraftStatus;
}

function parseSaveStatus(value: unknown): DraftStatus | undefined {
  const str = optionalString(value, 'status');
  if (str === undefined) return undefined;
  if (!writableStatusSet.has(str)) {
    throw new HandlerError(
      `Field 'status' must be one of: ${WRITABLE_DRAFT_STATUSES.join(', ')}.`,
      BAD_INPUT,
      400,
    );
  }
  return str as DraftStatus;
}

function parseListQuery(body: unknown): DraftListQuery {
  const record = asRecord(body ?? {});
  const query: DraftListQuery = {};
  const status = parseListStatus(record.status);
  if (status !== undefined) query.status = status;
  const limit = optionalLimit(record.limit);
  if (limit !== undefined) query.limit = limit;
  return query;
}

function parseSaveInput(body: unknown): DraftSaveInput {
  const record = asRecord(body);
  const input: DraftSaveInput = {
    message: requiredString(record.message, 'message'),
  };
  const id = optionalString(record.id, 'id');
  if (id !== undefined) input.id = id;
  const wireReference = optionalString(record.wireReference, 'wireReference');
  if (wireReference !== undefined) input.wireReference = wireReference;
  const version = optionalVersion(record.version);
  if (version !== undefined) input.version = version;
  const title = optionalString(record.title, 'title');
  if (title !== undefined) input.title = title;
  const channel = optionalString(record.channel, 'channel');
  if (channel !== undefined) input.channel = channel;
  const route = optionalString(record.route, 'route');
  if (route !== undefined) input.route = route;
  const webhook = validateWebhook(optionalString(record.webhook, 'webhook'));
  if (webhook !== undefined) input.webhook = webhook;
  const link = optionalString(record.link, 'link');
  if (link !== undefined) input.link = link;
  const tags = optionalTags(record.tags);
  if (tags !== undefined) input.tags = tags;
  const status = parseSaveStatus(record.status);
  if (status !== undefined) input.status = status;
  const sentResponseId = optionalString(record.sentResponseId, 'sentResponseId');
  if (sentResponseId !== undefined) input.sentResponseId = sentResponseId;
  const sendError = optionalString(record.sendError, 'sendError');
  if (sendError !== undefined) input.sendError = sendError;
  const createdAt = optionalIso8601(record.createdAt, 'createdAt');
  if (createdAt !== undefined) input.createdAt = createdAt;
  const updatedAt = optionalIso8601(record.updatedAt, 'updatedAt');
  if (updatedAt !== undefined) input.updatedAt = updatedAt;
  return input;
}

/** Both get and delete identify a draft by `draftId` (per the platform input schema). */
function parseDraftId(body: unknown): string {
  const record = asRecord(body);
  return requiredString(record.draftId, 'draftId');
}

// --- Response shapes (match the platform output schemas) -------------------------

interface ListResponse {
  drafts: DraftRecord[];
  total: number;
}

/** get: a flat draft (CHANNEL_DRAFT_GET_OUTPUT permits additionalProperties) or a notFound marker. */
type GetResponse = DraftRecord | { notFound: true; id: string };

interface SaveResponse {
  draft: DraftRecord;
  created: boolean;
}

interface DeleteResponse {
  deleted: boolean;
  draftId: string;
}

export interface RegisterDraftsOptions {
  /** Override the sqlite filename (tests). */
  fileName?: string;
  /** Inject a pre-built store (tests). When provided, the caller owns its lifecycle. */
  store?: DraftSyncStore;
}

/** Compatible callable teardown with an explicit owned-work completion boundary. */
export interface DraftRegistration {
  (): void;
  /** Stop admission, drain accepted handlers, then close only an owned store. */
  close(): Promise<void>;
}

/**
 * Register the channels.drafts.* handlers against the catalog held by `ctx`.
 * Returns a callable teardown that removes all four handlers. New roots must
 * await its close() before transferring ownership; borrowed stores stay open.
 *
 * The store is created eagerly but initialized lazily on first invocation (the
 * SQLite WASM load is deferred until a draft method is actually called). Every
 * mutating handler persists the store via save() after the mutation so the
 * mirror survives daemon restarts.
 */
export function registerDraftMethods(
  ctx: HandlerContext,
  options: RegisterDraftsOptions = {},
): DraftRegistration {
  // Validate the whole canonical family before attaching any handler. Retain
  // descriptors so an awaited teardown leaves the same catalog reusable.
  const descriptors = [LIST_ID, GET_ID, SAVE_ID, DELETE_ID].map((id) => {
    const descriptor = ctx.catalog.get(id);
    if (!descriptor) throw new HandlerError(`Unknown gateway method: ${id}`, 'METHOD_NOT_FOUND', 404);
    return descriptor;
  });
  const store =
    options.store
    ?? new DraftSyncStore({
      workingDirectory: ctx.workingDirectory,
      cipher: createAtRestCipher(ctx.credentials),
      ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
    });

  let initPromise: Promise<void> | null = null;
  const ensureInit = (): Promise<void> => {
    if (initPromise) return initPromise;
    const pending = store.init();
    initPromise = pending;
    void pending.catch(() => { if (initPromise === pending) initPromise = null; });
    return pending;
  };
  let closed = false;
  let closing: Promise<void> | undefined;
  let mutationTail: Promise<unknown> = Promise.resolve();
  const active = new Set<Promise<unknown>>();
  const closedError = () => new HandlerError('The draft service is shutting down; nothing was changed. Retry once the daemon is back.', 'DRAFT_SURFACE_CLOSED', 409);
  const admit = (handler: TypedHandler<unknown, unknown>, mutation = false): TypedHandler<unknown, unknown> => (input) => {
    if (closed) return Promise.reject(closedError());
    // Track before a store/cipher callback can reenter teardown. Writes are
    // serialized through persistence, so delete cannot be undone by an older
    // save that was still encrypting its body when the delete arrived.
    const work = (mutation ? mutationTail : Promise.resolve()).then(() => { input.context.signal?.throwIfAborted(); return handler(input); });
    active.add(work);
    if (mutation) mutationTail = work.then(() => {}, () => {});
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };

  const listHandler: TypedHandler<unknown, ListResponse> = async ({ body }) => {
    await ensureInit();
    const query = parseListQuery(body);
    const drafts = store.list(query).map(record => ({ ...record, id: channelDraftWireReference(record.id, record.wireReference) }));
    return { drafts, total: store.count(query.status) };
  };

  const getHandler: TypedHandler<unknown, GetResponse> = async ({ body, context }) => {
    await ensureInit();
    const id = parseDraftId(body);
    const privateId = isNativeDraftWireReference(id) ? store.resolveReferenceId(id) : id;
    // The owner reads the text, so a draft written on one device can be
    // finished and sent on another; anyone else gets the redacted record.
    const record = privateId === undefined ? null : context.admin ? await store.getReadable(privateId) : store.get(privateId);
    if (record === null) { snapshotJudgmentInput({ draftId: id }); return { notFound: true, id }; }
    return { ...record, id: channelDraftWireReference(record.id, record.wireReference) };
  };

  /**
   * The selected row as admission sees it: under its wire reference, never its
   * stored id, which can be one the card-material screen refuses to read.
   */
  const publicRow = (row: DraftRecord | null): DraftRecord | null =>
    row === null ? null : { ...row, id: channelDraftWireReference(row.id, row.wireReference) };

  /** A wire reference or id names exactly one stored row; a reference that names none is refused. */
  const selectStoredId = (requested: string): string => {
    if (!isNativeDraftWireReference(requested)) return requested;
    const selected = store.resolveReferenceId(requested);
    if (selected === undefined) {
      throw new HandlerError(`No draft is stored under the reference ${requested}; list the drafts to find it.`, 'NATIVE_DRAFT_REFERENCE_UNAVAILABLE', 404);
    }
    return selected;
  };

  const saveHandler: TypedHandler<unknown, SaveResponse> = async ({ body, context }) => {
    const autonomous = isDelegatedCaller(context);
    if (!autonomous) assertConfirmed(body, context);
    context.signal?.throwIfAborted();
    await ensureInit();
    // Parsed once into a value nothing downstream can change; every later step
    // reads this value, so none has to check that the request is still the same.
    const parsed = parseSaveInput(body);
    const publicId = parsed.id;
    const id = publicId === undefined ? (autonomous ? crypto.randomUUID() : undefined) : selectStoredId(publicId);
    const input: DraftSaveInput = Object.freeze({ ...parsed, ...(id !== undefined ? { id } : {}), ...(parsed.tags ? { tags: Object.freeze([...parsed.tags]) as string[] } : {}) });
    // The row this save read. An autonomous write applies only to it.
    const selected = autonomous && id !== undefined ? store.selectRow(id) : undefined;
    return await runNativeMutation({ host: ctx.nativeMutationHost, method: SAVE_ID, body, context,
      target: { id: publicRow(selected?.target ?? null)?.id ?? publicId ?? id ?? null, current: publicRow(selected?.target ?? null), encryption: 'native daemon at-rest key' },
      assertTargetCurrent: () => { if (closed) throw closedError(); },
      async mutate(assertCurrent, _admission, withPublication) {
        // A manual save is staged and published as one write: one that cannot
        // be saved leaves the store as it was instead of changed in memory only.
        const result = await store.upsert(input, autonomous ? assertCurrent : undefined, withPublication, !autonomous, selected?.updatedAt);
        const wireId = publicId !== undefined && isNativeDraftWireReference(publicId) ? publicId : result.draft.wireReference;
        return { ...result, draft: { ...result.draft, id: wireId } };
      } });
  };

  const deleteHandler: TypedHandler<unknown, DeleteResponse> = async ({ body, context }) => {
    const autonomous = isDelegatedCaller(context);
    if (!autonomous) assertConfirmed(body, context);
    context.signal?.throwIfAborted();
    await ensureInit();
    const requestedId = parseDraftId(body);
    const draftId = selectStoredId(requestedId);
    const selected = autonomous ? store.selectRow(draftId) : undefined;
    return await runNativeMutation({ host: ctx.nativeMutationHost, method: DELETE_ID, body, context,
      target: { id: publicRow(selected?.target ?? null)?.id ?? requestedId, current: publicRow(selected?.target ?? null) },
      assertTargetCurrent: () => { if (closed) throw closedError(); },
      async mutate(assertCurrent, _admission, withPublication) {
        const deleted = await store.deleteAdmitted(draftId, assertCurrent, withPublication, selected?.updatedAt);
        return { deleted, draftId: requestedId };
      } });
  };

  const unregister = registerCatalogHandlers(ctx.catalog, [
    { id: LIST_ID, handler: admit(listHandler as TypedHandler<unknown, unknown>) },
    { id: GET_ID, handler: admit(getHandler as TypedHandler<unknown, unknown>) },
    {
      id: SAVE_ID,
      handler: admit(saveHandler as TypedHandler<unknown, unknown>, true),
    },
    {
      id: DELETE_ID,
      handler: admit(deleteHandler as TypedHandler<unknown, unknown>, true),
    },
  ]);

  const ownsStore = options.store === undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    const errors: unknown[] = [];
    try { unregister(); } catch (error) { errors.push(error); }
    for (const descriptor of descriptors) {
      try { ctx.catalog.register(descriptor, undefined, { replace: true }); } catch (error) { errors.push(error); }
    }
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...active]);
      if (ownsStore) {
        try { await store.close(); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Draft surface did not close cleanly');
    });
    void closing.catch(() => {
      // Value-free reporting for legacy void callers; awaiting close still
      // receives the failure and prevents a silent ownership transfer.
      try { ctx.logger.warn('Draft surface did not close cleanly'); } catch { /* Preserve cleanup outcome. */ }
    });
    return closing;
  };
  return Object.assign(() => { void close(); }, { close });
}

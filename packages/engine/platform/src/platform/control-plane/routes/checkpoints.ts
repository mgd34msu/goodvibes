/**
 * routes/checkpoints.ts
 *
 * (see CHANGELOG 1.0.0), `checkpoints.list` / `checkpoints.create` / `checkpoints.diff` /
 * `checkpoints.restore` gateway-method handlers over the ALREADY
 * daemon-resident `WorkspaceCheckpointManager` (constructed +
 * eagerly-`init()`'d at ../../runtime/services.ts:620, exposed on
 * RuntimeServices at :245). Thin verb registration over an existing manager
 *, see routes/fleet.ts's header comment for the full rationale on why these
 * are wired via `GatewayMethodCatalog.register(descriptor, handler)` instead
 * of a daemon-api REST route or a router.ts change.
 *
 * CONFIRMATION CONTRACT: `checkpoints.restore` refuses to run unconfirmed.
 * A caller must supply EITHER `confirm: true` (an explicit acknowledgment that
 * the destructive restore should execute immediately) OR a `confirmToken`
 * obtained from a prior `checkpoints.restorePreview` call (which returns a
 * short-lived, single-use token plus a preview of what would change). An
 * unconfirmed call is NOT an error, it returns a structured, non-destructive
 * refusal body (`result: null, refused: true, refusal: {...}`) that names both
 * paths, so a surface can proceed without guessing. Existing callers that
 * already gate restore behind their own UI confirm (the TUI's DiffPanel
 * confirm overlay, src/input/commands/checkpoint-runtime.ts) keep working by
 * adding the single field `confirm: true` to their restore invocation; no
 * preview round-trip is forced on them. A webui that fires restore blind now
 * gets the actionable refusal instead of a silent git-backed workspace rewrite.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { WorkspaceCheckpointManager } from '../../workspace/checkpoint/manager.js';
import type { CheckpointKind, RetentionClass } from '../../workspace/checkpoint/types.js';
import { othersUndoneLines, type OtherSessionChanges } from '../../workspace/checkpoint/taken-back.js';
import { applyHunkRevert, HunkRevertConflictError, previewHunkRevert } from '../../workspace/hunk-revert.js';
import type { WorkspaceEvent } from '../../../events/workspace.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { ReviewTokenStore } from '../review-tokens.js';
import { noteListChanged, type ListChange } from '../../runtime/list-changes.js';
import { projectIdentityOf } from '../../workspace/project-identity.js';
import { contentDigest, TargetChangedError, targetRef, type TargetRef } from '../../utils/target-ref.js';

/** Sink for the checkpoints.revertHunk receipt event (adapted onto the RuntimeEventBus by the registrar). */
export type CheckpointsEventSink = (event: WorkspaceEvent, sessionId: string) => void;

/** The two ways to authorize a hunk revert, named verbatim in the refusal body. */
const REVERT_HUNK_CONFIRM_OPTIONS: readonly string[] = [
  'Pass confirm:true to acknowledge the working-tree write and execute it immediately.',
  'Call checkpoints.revertHunkPreview for this hunk, then pass the returned token as confirmToken.',
];

/** How many affected paths a restore preview lists inline before it is just a count. */
const RESTORE_PREVIEW_PATH_SAMPLE_LIMIT = 20;

/** The two ways to authorize a restore, named verbatim in the refusal body. */
const RESTORE_CONFIRM_OPTIONS: readonly string[] = [
  'Pass confirm:true to acknowledge the destructive restore and execute it immediately.',
  'Call checkpoints.restorePreview for this id, then pass the returned token as confirmToken.',
];

const CHECKPOINT_KINDS: readonly CheckpointKind[] = ['turn', 'agent-run', 'manual'];
const RETENTION_CLASSES: readonly RetentionClass[] = ['short', 'standard', 'forensic'];

const CHECKPOINTS_LIST_DEFAULT_LIMIT = 100;
const CHECKPOINTS_LIST_MAX_LIMIT = 500;

/**
 * `WorkspaceCheckpointManager.requireCheckpoint` (../../workspace/checkpoint/manager.ts:599-604,
 * private) throws a plain `Error` with this exact message shape for an
 * unknown/gc'd id. `diff`/`restore` both route through it. There is no
 * public `get(id)` to pre-check existence without a second full manager
 * call, so this handler matches the message text the manager already
 * commits to (any manager.ts rewrite of that string is covered by the
 * bootDaemon proof test, see test/fleet-checkpoints-search.test.ts, as a regression net,
 * not by this string match alone).
 */
const NO_CHECKPOINT_FOUND_MARKER = 'no checkpoint found with id';

async function callOrHonestNotFound<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(NO_CHECKPOINT_FOUND_MARKER)) {
      // Preserve the manager's own message (it already names the specific
      // missing id), only the status/code are being upgraded from the
      // blanket 500 a plain throw would collapse to.
      throw new GatewayVerbError(message, 'NOT_FOUND', 404);
    }
    throw err;
  }
}

/**
 * What a restore preview showed: the checkpoint, in the workspace root it restores, and the other sessions' changes it
 * takes back. A token confirms exactly those: another session's change made since the preview is a changed target.
 */
function checkpointTarget(id: string, root: string, others: readonly OtherSessionChanges[], laterByOthers: readonly string[]): TargetRef<'checkpoint'> {
  const takesBack = others.map((other) => ({ sessionId: other.sessionId, files: [...other.files] }));
  return targetRef('checkpoint', id, { root, takesBack, laterByOthers: [...laterByOthers] },
    { root, takesBack: othersSentence(others) || 'no other session\'s change', laterByOthers: laterByOthers.join(', ') || 'none' }, root);
}

/** The checkpoints other sessions made after checkpoint `id`: a change made since a preview adds one, even to the same file. */
async function laterCheckpointsByOthers(holder: CheckpointsGatewayManager, id: string, caller: string | undefined): Promise<string[]> {
  const all = await holder.list({ limit: CHECKPOINTS_LIST_MAX_LIMIT });
  const target = all.find((checkpoint) => checkpoint.id === id);
  if (!target) return [];
  return all.filter((checkpoint) => checkpoint.createdAt > target.createdAt && checkpoint.sessionId !== undefined && checkpoint.sessionId !== caller)
    .map((checkpoint) => checkpoint.id).sort();
}

/** The other sessions' changes, in one line a person reads ("session s-1 (its agent a-2): b.txt; session s-3: c.txt"). */
function othersSentence(others: readonly OtherSessionChanges[]): string {
  return othersUndoneLines(others).map((line) => line.trim()).join('; ');
}

/** The other sessions' changes a restore of `id` by `caller` would take back (none when the host keeps no record of whose). */
async function othersTakenBack(holder: CheckpointsGatewayManager, id: string, caller: string | undefined, paths?: readonly string[]): Promise<OtherSessionChanges[]> {
  if (!holder.othersUndoneBy) return [];
  return callOrHonestNotFound(() => holder.othersUndoneBy!(id, { sessionId: caller, paths }));
}

/**
 * What a hunk revert preview showed: the hunk in the file as it read then, in
 * that workspace root, for that session. The session is kept as shown text so
 * the apply acts in the previewed workspace whatever session it names.
 */
function hunkTarget(root: string, path: string, hunk: string, content: string, sessionId: string | undefined): TargetRef<'hunk'> {
  const file = contentDigest(content);
  return targetRef('hunk', path, { root, hunk, file },
    { root, session: sessionId ?? '', file: `${path} at ${file.slice(0, 12)}` }, root);
}

function tokenRefused(reason: 'unknown' | 'expired' | 'changed', what: string, previewMethod: string): GatewayVerbError {
  return new GatewayVerbError(
    `confirmToken is ${reason === 'expired' ? 'expired' : 'unknown or already used'}; nothing was ${what}. Call ${previewMethod} to obtain a fresh one.`,
    'INVALID_ARGUMENT',
    400,
    'confirmToken',
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new GatewayVerbError(`Invalid number for field: ${field}`, 'INVALID_ARGUMENT', 400, field);
  }
  return n;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new GatewayVerbError('Invalid field: paths must be a string array', 'INVALID_ARGUMENT', 400, 'paths');
  }
  return value as string[];
}

/**
 * A restore scope must name at least one path: an empty list would otherwise
 * be read as "no scope" by a caller that selected nothing. Whole-workspace
 * restore is requested by omitting `paths`.
 */
function restorePaths(value: unknown): string[] | undefined {
  const paths = optionalStringArray(value);
  if (paths !== undefined && paths.length === 0) {
    throw new GatewayVerbError(
      'paths is an empty list, so nothing was restored and no confirmToken was spent. Name at least one path, or omit paths to restore the whole workspace.',
      'INVALID_ARGUMENT',
      400,
      'paths',
    );
  }
  return paths;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new GatewayVerbError(`Invalid boolean for field: ${field}`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

function validateCheckpointKind(value: unknown, required: boolean): CheckpointKind | undefined {
  if (value === undefined || value === null) {
    if (required) throw new GatewayVerbError('Missing required field: kind', 'INVALID_ARGUMENT', 400, 'kind');
    return undefined;
  }
  if (typeof value !== 'string' || !CHECKPOINT_KINDS.includes(value as CheckpointKind)) {
    throw new GatewayVerbError(
      `Invalid kind: ${String(value)} (expected one of ${CHECKPOINT_KINDS.join(', ')})`,
      'INVALID_ARGUMENT',
      400,
      'kind',
    );
  }
  return value as CheckpointKind;
}

function validateRetentionClass(value: unknown): RetentionClass | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !RETENTION_CLASSES.includes(value as RetentionClass)) {
    throw new GatewayVerbError(
      `Invalid retentionClass: ${String(value)} (expected one of ${RETENTION_CLASSES.join(', ')})`,
      'INVALID_ARGUMENT',
      400,
      'retentionClass',
    );
  }
  return value as RetentionClass;
}

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return CHECKPOINTS_LIST_DEFAULT_LIMIT;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new GatewayVerbError(`Invalid limit: ${String(raw)}`, 'INVALID_ARGUMENT', 400, 'limit');
  }
  return Math.min(Math.floor(n), CHECKPOINTS_LIST_MAX_LIMIT);
}

/** Structural deps, the read/write surface `checkpoints.*` + `sessions.changes.get` needs. */
export type CheckpointsGatewayManager = Pick<WorkspaceCheckpointManager, 'list' | 'create' | 'diff' | 'restore' | 'sessionChanges' | 'workspaceRoot' | 'resolveRoot'>
  & Partial<Pick<WorkspaceCheckpointManager, 'retentionFailure' | 'historyTrimmed' | 'othersUndoneBy' | 'noteTakenBack'>>
  & {
    /**
     * The manager of the workspace a session works in, when the host keeps one
     * per workspace (a daemon hosting sessions in other projects). Undefined:
     * the session works in this manager's workspace.
     */
    forSession?(sessionId: string): CheckpointsGatewayManager | undefined;
    /** The manager whose store holds checkpoint `id`, when the host keeps several. Undefined: this one. */
    forCheckpoint?(id: string): Promise<CheckpointsGatewayManager | undefined>;
    /**
     * The manager of the project a call names (its call context), when the host keeps one per project: the project's one
     * store, which every program of that project (the terminal app, the Agent, the daemon's own runs) keeps its
     * checkpoints in. Undefined: this one.
     */
    forProject?(folder: string): CheckpointsGatewayManager | undefined;
  };

/** The project a call names (explicit workingDirectory/project param, else call context), if any. */
function callProjectOf(
  invocation: { readonly context?: { readonly call?: { readonly project?: string | undefined } | undefined } | undefined },
  params?: Readonly<Record<string, unknown>>,
): string | undefined {
  return optionalString(params?.workingDirectory) ?? optionalString(params?.project) ?? invocation.context?.call?.project;
}

/** The manager for the session's workspace, else for the project the call names, or the default one. */
function managerFor(manager: CheckpointsGatewayManager, sessionId: string | undefined, project?: string): CheckpointsGatewayManager {
  return (sessionId === undefined ? undefined : manager.forSession?.(sessionId))
    ?? (project === undefined ? undefined : manager.forProject?.(project))
    ?? manager;
}

/**
 * The manager whose store holds the checkpoint, else the project's the call names, or the default one (each answers
 * an unknown id with its 404).
 */
async function managerHolding(manager: CheckpointsGatewayManager, id: string, project?: string): Promise<CheckpointsGatewayManager> {
  return (await manager.forCheckpoint?.(id)) ?? (project === undefined ? undefined : manager.forProject?.(project)) ?? manager;
}

export function createCheckpointsListHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const kind = validateCheckpointKind(params.kind, false);
    const sessionId = optionalString(params.sessionId);
    const since = optionalNumber(params.since, 'since');
    const limit = clampLimit(params.limit);
    const scoped = managerFor(manager, sessionId, callProjectOf(invocation, params));
    const checkpoints = await scoped.list({ kind, sessionId, since, limit });
    // Present only while the last automatic retention sweep is failing, so a
    // store that is growing past its limits says why instead of looking healthy.
    const retentionFailure = scoped.retentionFailure?.() ?? null;
    // What retention last removed, so an agent offered rewind knows why an older checkpoint is gone.
    const historyTrimmed = scoped.historyTrimmed?.() ?? null;
    return {
      checkpoints,
      ...(retentionFailure ? { retentionFailure } : {}),
      ...(historyTrimmed ? { historyTrimmed } : {}),
    };
  };
}

/**
 * `sessions.changes.get`, the aggregate workspace file changes a session made,
 * joined over its sessionId-stamped checkpoints (see
 * WorkspaceCheckpointManager.sessionChanges). A session with no stamped
 * checkpoints returns checkpointCount:0 with an empty diff, not an error.
 */
export function createSessionChangesHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireStringValue(params.sessionId, 'sessionId');
    const changes = await managerFor(manager, sessionId, callProjectOf(invocation, params)).sessionChanges(sessionId);
    return changes;
  };
}

export function createCheckpointsCreateHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const body = readInvocationParams(invocation);
    const kind = validateCheckpointKind(body.kind, true);
    if (!kind) throw new GatewayVerbError('Missing required field: kind', 'INVALID_ARGUMENT', 400, 'kind');
    const checkpoint = await managerFor(manager, optionalString(body.sessionId), callProjectOf(invocation, body)).create({
      kind,
      label: optionalString(body.label),
      retentionClass: validateRetentionClass(body.retentionClass),
      turnId: optionalString(body.turnId),
      agentId: optionalString(body.agentId),
      sessionId: optionalString(body.sessionId),
      paths: optionalStringArray(body.paths),
    });
    // `create` returns null when the workspace tree is unchanged since the
    // parent checkpoint (manager.ts:349-357), an honest no-op, not an
    // error and not a fabricated checkpoint record.
    return { checkpoint, noop: checkpoint === null };
  };
}

export function createCheckpointsDiffHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const a = requireStringValue(params.a, 'a');
    const b = optionalString(params.b);
    const holder = await managerHolding(manager, a, callProjectOf(invocation, params));
    const diff = await callOrHonestNotFound(() => holder.diff(a, b));
    return { diff };
  };
}

/**
 * Build a preview of what restoring checkpoint `id` would change: the label,
 * the affected-path count and a bounded sample, and the diffstat, all from the
 * manager's own diff against the live working tree (no workspace mutation). An
 * unknown/gc'd id surfaces as the same honest 404 `diff`/`restore` already use.
 */
export function createCheckpointsRestorePreviewHandler(
  manager: CheckpointsGatewayManager,
  tokens: ReviewTokenStore,
): GatewayMethodHandler {
  return async (invocation) => {
    const body = readInvocationParams(invocation);
    const id = requireStringValue(body.id, 'id');
    // `diff(id)` (second arg omitted) diffs the checkpoint against the live
    // working tree and routes through requireCheckpoint, so an unknown id is a
    // 404 here before any token is minted.
    const holder = await managerHolding(manager, id, callProjectOf(invocation, body));
    const diff = await callOrHonestNotFound(() => holder.diff(id));
    const checkpoint = (await holder.list()).find((c) => c.id === id);
    const affectedPaths = diff.files;
    // Whose changes it takes back, as the programs ask before a restore (recovery-commands.ts): every session but the
    // one restoring (the caller's own, from its call or the body).
    const caller = invocation.context?.call?.sessionId ?? optionalString(body.sessionId);
    const others = await othersTakenBack(holder, id, caller);
    const { token, expiresAt } = tokens.issue(checkpointTarget(id, await holder.resolveRoot(), others, await laterCheckpointsByOthers(holder, id, caller)));
    return {
      token,
      expiresAt,
      preview: {
        checkpointId: id,
        label: checkpoint?.label ?? '',
        affectedPathCount: affectedPaths.length,
        affectedPathSample: affectedPaths.slice(0, RESTORE_PREVIEW_PATH_SAMPLE_LIMIT),
        stat: diff.stat,
        otherSessions: others.map((other) => ({ sessionId: other.sessionId, agentIds: [...other.agentIds], files: [...other.files] })),
        ...(others.length > 0 ? { takesBack: `It takes back changes other sessions made: ${othersSentence(others)}. They are told in their conversations.` } : {}),
      },
    };
  };
}

export function createCheckpointsRestoreHandler(
  manager: CheckpointsGatewayManager,
  tokens: ReviewTokenStore,
): GatewayMethodHandler {
  return async (invocation) => {
    const body = readInvocationParams(invocation);
    const id = requireStringValue(body.id, 'id');
    const confirm = optionalBoolean(body.confirm, 'confirm');
    const confirmToken = optionalString(body.confirmToken);
    // Checked before the token is spent so a rejected scope costs no re-preview.
    const paths = restorePaths(body.paths);
    if (body.takeBack !== undefined && body.takeBack !== null && !(Array.isArray(body.takeBack) && body.takeBack.every((v) => typeof v === 'string'))) {
      throw new GatewayVerbError('takeBack must be a list of session ids (as checkpoints.restorePreview lists them); nothing was restored.', 'INVALID_ARGUMENT', 400, 'takeBack');
    }
    const takeBack = Array.isArray(body.takeBack) ? body.takeBack as string[] : undefined;
    // Whose changes this restore takes back (every session but the caller's own), read before anything is decided.
    const caller = invocation.context?.call?.sessionId ?? optionalString(body.sessionId);
    const holding = await managerHolding(manager, id, callProjectOf(invocation, body));
    const others = await othersTakenBack(holding, id, caller, paths);

    if (confirmToken !== undefined) {
      // The preview a token vouches for described a restore with its undo
      // point. Letting the same token skip that undo point would run something
      // the preview never showed, so it is refused before the token is spent.
      if (optionalBoolean(body.safetyCheckpoint, 'safetyCheckpoint') === false) {
        throw new GatewayVerbError(
          'A restore confirmed with a confirmToken always creates its safety checkpoint, so safetyCheckpoint: false is refused and the token was not spent. Omit safetyCheckpoint, or confirm with confirm: true instead of a token to restore without an undo point.',
          'INVALID_ARGUMENT',
          400,
          'safetyCheckpoint',
        );
      }
      // An explicit token that does not check out is a real failure of the
      // caller's confirm attempt (not the "you didn't confirm" refusal), so it
      // is an honest 400 that names the remedy, mint a fresh one. A token for
      // another checkpoint or workspace, or one whose preview showed other sessions' changes than this restore would
      // take back now, is refused with what differs.
      const spent = tokens.consume(confirmToken, checkpointTarget(id, await holding.resolveRoot(), paths ? await othersTakenBack(holding, id, caller) : others,
        await laterCheckpointsByOthers(holding, id, caller)));
      if (!spent.ok && spent.reason === 'changed' && spent.reviewed) {
        throw new TargetChangedError(spent.reviewed, spent.changes ?? [], `checkpoints.restorePreview with id ${id}`);
      }
      if (!spent.ok) throw tokenRefused(spent.reason, 'restored', 'checkpoints.restorePreview');
    } else if (confirm !== true) {
      // Unconfirmed: honest, actionable, NON-destructive. Not a thrown error,
      // a 200 body the caller can branch on.
      return {
        result: null,
        refused: true,
        refusal: {
          reason: 'checkpoints.restore is destructive (a git-backed workspace rewrite) and requires confirmation before it will run.',
          confirmField: 'confirm',
          previewMethod: 'checkpoints.restorePreview',
          options: RESTORE_CONFIRM_OPTIONS,
        },
      };
    } else {
      // confirm:true takes back another session's change only when the caller named that session (as the programs ask
      // the person before such a restore): so no caller takes back another session's work unseen.
      const named = new Set(takeBack ?? []);
      const unnamed = others.filter((other) => !named.has(other.sessionId));
      if (unnamed.length > 0) {
        return {
          result: null,
          refused: true,
          refusal: {
            reason: `Not restored: it would take back changes other sessions made: ${othersSentence(unnamed)}. Nothing was changed, and their changes are kept.`,
            confirmField: 'takeBack',
            previewMethod: 'checkpoints.restorePreview',
            options: [
              `Pass takeBack naming ${unnamed.length === 1 ? 'that session' : 'each of those sessions'} (${unnamed.map((other) => other.sessionId).join(', ')}) with confirm:true to take ${unnamed.length === 1 ? 'its changes' : 'their changes'} back; ${unnamed.length === 1 ? 'it is' : 'they are'} told in ${unnamed.length === 1 ? 'its conversation' : 'their conversations'}.`,
              'Call checkpoints.restorePreview for this id, show what it lists, then pass its token as confirmToken.',
              'Restore only paths none of them changed (paths).',
            ],
            otherSessions: unnamed.map((other) => ({ sessionId: other.sessionId, agentIds: [...other.agentIds], files: [...other.files] })),
          },
        };
      }
    }

    const holder = holding;
    // Other sessions whose changes this takes back are told in their conversations (taken-back.ts).
    const result = await callOrHonestNotFound(() => holder.restore(id, {
      paths,
      safetyCheckpoint: optionalBoolean(body.safetyCheckpoint, 'safetyCheckpoint'),
    }));
    if (others.length > 0) await holder.noteTakenBack?.(others, caller ?? 'a remote caller', id, result.safetyCheckpointId).catch(() => undefined);
    return { result, refused: false, refusal: null };
  };
}

/**
 * `checkpoints.revertHunkPreview`, read-only: does reverse-applying this one
 * unified-diff hunk to its file apply cleanly right now? A stale/drifted hunk is
 * `applies:false` with a human-readable `conflict` and a null token (honest, not
 * an error); a clean hunk mints a single-use token bound to this exact (path,
 * hunk) that the matching checkpoints.revertHunk consumes.
 */
export function createCheckpointsRevertHunkPreviewHandler(
  manager: CheckpointsGatewayManager,
  tokens: ReviewTokenStore,
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requireStringValue(params.path, 'path');
    const hunk = requireStringValue(params.hunk, 'hunk', { verbatim: true });
    const sessionId = optionalString(params.sessionId);
    // Diff paths are relative to the root the manager resolved at init (the
    // enclosing repository's top level when started in a subdirectory), in the
    // workspace of the session the diff came from.
    const root = await managerFor(manager, sessionId, callProjectOf(invocation, params)).resolveRoot();
    let content = '';
    const preview = previewHunkRevert(root, path, hunk, (read) => { content = read; });
    if (!preview.applies) {
      return { ...preview, token: null, expiresAt: null };
    }
    // The token binds the workspace, the hunk and the file as it read now: the
    // apply acts in this root, and refuses when the file changed since.
    const { token, expiresAt } = tokens.issue(hunkTarget(root, path, hunk, content, sessionId));
    return { ...preview, token, expiresAt };
  };
}

/**
 * `checkpoints.revertHunk`, confirm-gated reverse-apply of ONE hunk to the live
 * working tree, following the checkpoints.restore / rewind.apply confirm idiom:
 * an unconfirmed call is a non-error refusal, a bad token is a 400, and a hunk
 * that no longer applies cleanly is a 409 conflict (never a partial write). The
 * apply snapshots the whole tree first (the undo point) and emits a HUNK_REVERTED
 * receipt event when an event sink is wired.
 */
export function createCheckpointsRevertHunkHandler(
  manager: CheckpointsGatewayManager,
  tokens: ReviewTokenStore,
  emit?: CheckpointsEventSink,
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requireStringValue(params.path, 'path');
    const hunk = requireStringValue(params.hunk, 'hunk', { verbatim: true });
    let sessionId = optionalString(params.sessionId);
    const confirm = optionalBoolean(params.confirm, 'confirm');
    const confirmToken = optionalString(params.confirmToken);
    // With a token, the workspace is the one the preview read, never the one
    // the apply call's sessionId resolves to now.
    let verify: ((content: string, root: string) => void) | undefined;
    if (confirmToken !== undefined) {
      const reviewed = tokens.peek(confirmToken);
      if (!reviewed) {
        // Spent here too, so an expired token does not linger.
        const spent = tokens.consume(confirmToken, null);
        throw tokenRefused(spent.ok ? 'unknown' : spent.reason, 'reverted', 'checkpoints.revertHunkPreview');
      }
      sessionId = reviewed.shown.session || undefined;
      const previewedSession = sessionId;
      verify = (content, root) => {
        const spent = tokens.consume(confirmToken, hunkTarget(root, path, hunk, content, previewedSession));
        if (!spent.ok && spent.reason === 'changed' && spent.reviewed) {
          throw new TargetChangedError(spent.reviewed, spent.changes ?? [], `checkpoints.revertHunkPreview with path ${path}${previewedSession ? ` and sessionId ${previewedSession}` : ''}`);
        }
        if (!spent.ok) throw tokenRefused(spent.reason, 'reverted', 'checkpoints.revertHunkPreview');
      };
    } else if (confirm !== true) {
      return {
        receipt: null,
        refused: true,
        refusal: {
          reason: 'checkpoints.revertHunk mutates the working tree (reverse-applies a hunk) and requires confirmation before it will run.',
          confirmField: 'confirm',
          previewMethod: 'checkpoints.revertHunkPreview',
          options: REVERT_HUNK_CONFIRM_OPTIONS,
        },
      };
    }

    let receipt;
    let workspaceRoot = '';
    try {
      receipt = await applyHunkRevert(managerFor(manager, sessionId, callProjectOf(invocation, params)), path, hunk, (content, root) => {
        workspaceRoot = root;
        verify?.(content, root);
      });
    } catch (err) {
      if (err instanceof HunkRevertConflictError) {
        // The hunk went stale (the file changed since the diff was taken). Honest
        // 409, nothing was written, so the caller can re-diff and retry.
        throw new GatewayVerbError(err.message, 'CONFLICT', 409);
      }
      throw err;
    }
    if (emit) {
      emit(
        {
          type: 'HUNK_REVERTED',
          path: receipt.path,
          hunkHeader: receipt.hunkHeader,
          sessionId: sessionId ?? null,
          safetyCheckpointId: receipt.safetyCheckpointId,
          undoAvailable: receipt.undo !== null,
        },
        sessionId ?? 'workspace',
      );
    }
    return { receipt: { ...receipt, workspaceRoot }, refused: false, refusal: null };
  };
}

/** The one thing the checkpoint notice needs of the session broker: is the session known. */
export interface SessionCheckpointNoticeBroker {
  getSession(sessionId: string): unknown;
}

const CHECKPOINT_CHANGES: readonly ListChange['change'][] = ['created', 'changed', 'deleted'];

/**
 * `sessions.checkpoints.changed`: a terminal program that keeps its own checkpoints (the terminal
 * app, the Agent) made, pruned or removed one for a session this daemon knows. The daemon
 * announces it as LIST_CHANGED `checkpoints`, as its own checkpoint writes are, so a subscribed
 * client reads the list again. Nothing is stored; a repeat only announces again.
 */
export function createSessionCheckpointNoticeHandler(broker: SessionCheckpointNoticeBroker, checkpoints?: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireStringValue(params.sessionId, 'sessionId');
    const change = params.change;
    if (typeof change !== 'string' || !(CHECKPOINT_CHANGES as readonly string[]).includes(change)) {
      throw new GatewayVerbError('change must be one of created, changed or deleted', 'INVALID_ARGUMENT', 400, 'change');
    }
    const checkpointId = params.checkpointId;
    if (checkpointId !== undefined && (typeof checkpointId !== 'string' || checkpointId.length === 0)) {
      throw new GatewayVerbError('checkpointId must be a non-empty string when given', 'INVALID_ARGUMENT', 400, 'checkpointId');
    }
    if (broker.getSession(sessionId) == null) {
      throw new GatewayVerbError(`No shared session ${sessionId}: register it with sessions.register first. Nothing was announced.`, 'SESSION_NOT_FOUND', 404);
    }
    // A program's checkpoint is its project's (the call's project, already checked by the dispatch), and its session's.
    const project = callProjectOf(invocation, params);
    const identity = project !== undefined ? projectIdentityOf(project) : undefined;
    // What the notice is about, declared only once the daemon checked it (events/about.ts): the checkpoint is one that
    // project's store holds (the one store a project's programs and the daemon's runs share). A checkpoint it does not
    // hold (another project's, or none) is not declared, so the stream filter gives the notice to the owner alone.
    let about: { readonly about: { readonly project: string; readonly kind: 'checkpoint'; readonly id: string } } | undefined;
    if (typeof checkpointId === 'string' && identity !== undefined && checkpoints?.forProject) {
      const store = checkpoints.forProject(identity);
      const held = store ? await store.list({}).then((list) => list.some((checkpoint) => checkpoint.id === checkpointId), () => false) : false;
      if (held) about = { about: { project: identity, kind: 'checkpoint', id: checkpointId } };
    }
    noteListChanged({ list: 'checkpoints', change: change as ListChange['change'], ...(checkpointId ? { id: checkpointId } : {}),
      ...(identity !== undefined ? { project: identity } : {}), sessionId, ...(about ?? {}) });
    return { announced: true };
  };
}

/** Attach `sessions.checkpoints.changed` to its descriptor; a missing descriptor is a silent no-op. */
export function registerSessionCheckpointNotice(catalog: GatewayMethodCatalog, broker: SessionCheckpointNoticeBroker, checkpoints?: CheckpointsGatewayManager): void {
  const descriptor = catalog.get('sessions.checkpoints.changed');
  if (descriptor) catalog.register(descriptor, createSessionCheckpointNoticeHandler(broker, checkpoints), { replace: true });
}

/**
 * Attach the `checkpoints.*` handlers to the descriptors already registered
 * (without a handler) from ../method-catalog-control-core.ts's static
 * builtin array. Call once, at RuntimeServices construction time, after
 * `workspaceCheckpointManager` exists. A missing descriptor is a silent
 * no-op, see routes/fleet.ts's `registerFleetGatewayMethods` for the same
 * rationale.
 */
export function registerCheckpointGatewayMethods(
  catalog: GatewayMethodCatalog,
  manager: CheckpointsGatewayManager,
  emit?: CheckpointsEventSink,
): void {
  // One token store shared by the preview (mints) and restore (consumes)
  // handlers for this daemon's lifetime.
  const restoreTokens = new ReviewTokenStore();
  // A separate store for the per-hunk revert preview/apply pair, its tokens bind
  // to the hunk, its file and its workspace, so they never cross with
  // the whole-checkpoint restore tokens above.
  const revertHunkTokens = new ReviewTokenStore();

  // A checkpoint's owner, for the one check of what a caller may reach by id (control-plane/caller-reach.ts): the
  // workspace of the store that holds it, which is its project (a daemon's per-project store, found by `forCheckpoint`,
  // or this manager's own when it lists it). Held by none (or by a daemon's own folder, which keeps none): no project.
  catalog.setRecordOwner?.('checkpoint', async (id) => {
    const routed = await manager.forCheckpoint?.(id).catch(() => undefined);
    if (routed) return { project: routed.workspaceRoot };
    const own = await manager.list({}).catch(() => []);
    return { project: own.some((checkpoint) => checkpoint.id === id) ? manager.workspaceRoot : null };
  });

  const listDescriptor = catalog.get('checkpoints.list');
  if (listDescriptor) catalog.register(listDescriptor, createCheckpointsListHandler(manager), { replace: true });

  const createDescriptor = catalog.get('checkpoints.create');
  if (createDescriptor) catalog.register(createDescriptor, createCheckpointsCreateHandler(manager), { replace: true });

  const diffDescriptor = catalog.get('checkpoints.diff');
  if (diffDescriptor) catalog.register(diffDescriptor, createCheckpointsDiffHandler(manager), { replace: true });

  const restorePreviewDescriptor = catalog.get('checkpoints.restorePreview');
  if (restorePreviewDescriptor) {
    catalog.register(restorePreviewDescriptor, createCheckpointsRestorePreviewHandler(manager, restoreTokens), { replace: true });
  }

  const restoreDescriptor = catalog.get('checkpoints.restore');
  if (restoreDescriptor) catalog.register(restoreDescriptor, createCheckpointsRestoreHandler(manager, restoreTokens), { replace: true });

  const revertHunkPreviewDescriptor = catalog.get('checkpoints.revertHunkPreview');
  if (revertHunkPreviewDescriptor) {
    catalog.register(revertHunkPreviewDescriptor, createCheckpointsRevertHunkPreviewHandler(manager, revertHunkTokens), { replace: true });
  }

  const revertHunkDescriptor = catalog.get('checkpoints.revertHunk');
  if (revertHunkDescriptor) {
    catalog.register(revertHunkDescriptor, createCheckpointsRevertHunkHandler(manager, revertHunkTokens, emit), { replace: true });
  }

  // sessions.changes.get is a session-category verb, but it is served over the
  // same workspaceCheckpointManager as the checkpoints.* verbs (it joins the
  // session's stamped checkpoints), so its handler is attached here alongside
  // them rather than in a separate registration site.
  const sessionChangesDescriptor = catalog.get('sessions.changes.get');
  if (sessionChangesDescriptor) catalog.register(sessionChangesDescriptor, createSessionChangesHandler(manager), { replace: true });
}

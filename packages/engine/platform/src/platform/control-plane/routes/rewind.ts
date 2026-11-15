/**
 * routes/rewind.ts
 *
 * Handlers for rewind.plan, rewind.apply and rewind.undo over the
 * UnifiedRewindService. All are registered together with their descriptors from
 * register-gateway-verb-groups.ts. rewind.apply follows the checkpoints.restore
 * confirm idiom: an unconfirmed call returns a non-error refusal body, a bad
 * confirm token is an honest 400. rewind.undo puts a conversation back to how
 * it was before a rewind, from the undo snapshot id the receipt carries.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { RewindAnchor, RewindScope } from '../../rewind/index.js';
import { RewindTokenError, type UnifiedRewindService } from '../../rewind/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';

const REWIND_SCOPES: readonly RewindScope[] = ['files', 'conversation', 'both'];

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireStringValue(value, field);
}

function requireScope(value: unknown): RewindScope {
  if (typeof value !== 'string' || !REWIND_SCOPES.includes(value as RewindScope)) {
    throw new GatewayVerbError(
      `Invalid scope: ${String(value)} (expected one of ${REWIND_SCOPES.join(', ')})`,
      'INVALID_ARGUMENT',
      400,
      'scope',
    );
  }
  return value as RewindScope;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new GatewayVerbError(`Invalid ${field}: expected a boolean`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

function readAnchor(params: Record<string, unknown>): { anchor: RewindAnchor; scope: RewindScope } {
  const sessionId = requireStringValue(params.sessionId, 'sessionId');
  const turnId = optionalString(params.turnId, 'turnId');
  const scope = requireScope(params.scope);
  return { anchor: turnId !== undefined ? { sessionId, turnId } : { sessionId }, scope };
}

export function createRewindPlanHandler(service: Pick<UnifiedRewindService, 'plan'>): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const { anchor, scope } = readAnchor(params);
    return service.plan(anchor, scope);
  };
}

export function createRewindApplyHandler(service: Pick<UnifiedRewindService, 'apply'>): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const { anchor, scope } = readAnchor(params);
    const confirm = optionalBoolean(params.confirm, 'confirm');
    const confirmToken = optionalString(params.confirmToken, 'confirmToken');
    try {
      return await service.apply(anchor, scope, { confirm, confirmToken });
    } catch (error) {
      if (error instanceof RewindTokenError) {
        throw new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400, 'confirmToken');
      }
      throw error;
    }
  };
}

/** The reversal half of a conversation port: restore the pre-rewind copy, and say whether that is still safe. */
export interface RewindConversationUndoPort {
  restoreBefore(undoSnapshotId: string): boolean;
  messagesSinceRewind(undoSnapshotId: string): number | null;
}

/** What the surface hosting a session answered to an undo; null when no surface hosts it. */
export type RewindHostedUndoAnswer =
  | { readonly undone: true; readonly label: string }
  | { readonly undone: false; readonly label: string; readonly reason: string; readonly code: 'UNDO_POINT_GONE' | 'CONVERSATION_CHANGED' | null }
  | null;

/** Where rewind.undo finds a session's conversation. */
export interface RewindUndoDeps {
  /** Sessions a surface is hosting: their messages and undo snapshots live in that surface's process, which is asked. */
  readonly hosts?: { undo(sessionId: string, undoSnapshotId: string): Promise<RewindHostedUndoAnswer> } | null | undefined;
  /** The port of conversations this process holds itself; a port without the reversal half is ignored. */
  readonly local?: object | null | undefined;
}

/** A rewind.undo answer: exactly one of `undone` true or a `refusal`. */
export interface RewindUndoResult {
  readonly undone: boolean;
  readonly sessionId: string;
  readonly undoSnapshotId: string;
  readonly refusal: { readonly code: string; readonly state: string; readonly reason: string; readonly next: readonly string[] } | null;
}

function isUndoPort(port: object | null | undefined): port is RewindConversationUndoPort {
  return !!port
    && typeof (port as Partial<RewindConversationUndoPort>).restoreBefore === 'function'
    && typeof (port as Partial<RewindConversationUndoPort>).messagesSinceRewind === 'function';
}

export function createRewindUndoHandler(
  service: Pick<UnifiedRewindService, 'anchorsRestored'>,
  deps: RewindUndoDeps,
): GatewayMethodHandler {
  const local = isUndoPort(deps.local) ? deps.local : null;
  return async (invocation): Promise<RewindUndoResult> => {
    const params = readInvocationParams(invocation);
    const sessionId = requireStringValue(params.sessionId, 'sessionId');
    const undoSnapshotId = requireStringValue(params.undoSnapshotId, 'undoSnapshotId');
    const refused = (code: string, state: string, reason: string, next: readonly string[]): RewindUndoResult =>
      ({ undone: false, sessionId, undoSnapshotId, refusal: { code, state, reason, next } });

    const hosted = deps.hosts ? await deps.hosts.undo(sessionId, undoSnapshotId) : null;
    if (hosted && hosted.undone) {
      service.anchorsRestored(undoSnapshotId);
      return { undone: true, sessionId, undoSnapshotId, refusal: null };
    }
    if (hosted && !hosted.undone) {
      if (hosted.code === 'UNDO_POINT_GONE') {
        return refused('UNDO_POINT_GONE', 'the undo snapshot is gone',
          `${hosted.label} no longer holds that rewind's snapshot (${hosted.reason}); the conversation itself is unchanged`,
          ['Use rewind.plan and rewind.apply to move the conversation to the point you want']);
      }
      if (hosted.code === 'CONVERSATION_CHANGED') {
        return refused('CONVERSATION_CHANGED', hosted.reason,
          'Restoring the pre-rewind copy would discard what was added since, so nothing was changed',
          ['Fork the session to keep the current conversation, then rewind or undo in the fork']);
      }
      return refused('CONVERSATION_HOST_UNAVAILABLE', `the conversation is held by ${hosted.label}, which did not undo it`,
        hosted.reason,
        ['Read the conversation with sessions.messages.list, then retry if it was not restored', `Or undo it in ${hosted.label} with /undo rewind`]);
    }
    if (!local) {
      return refused('CONVERSATION_UNAVAILABLE', 'no conversation store is wired on this daemon',
        'This daemon holds no conversations, so it has no undo snapshots; nothing was changed',
        ['Reverse the file half of the rewind with checkpoints.restore and the receipt\'s undo.files.restoreCheckpointId']);
    }
    // The pre-rewind copy replaces the whole conversation, so it is only restored
    // while nothing newer was added since the rewind.
    const since = local.messagesSinceRewind(undoSnapshotId);
    if (since === null) {
      return refused('UNDO_POINT_GONE', 'the undo snapshot is gone',
        'That rewind can no longer be undone: only the newest 32 rewinds keep their snapshot, and one is restored only while its session is open here; the conversation itself is unchanged',
        ['Use rewind.plan and rewind.apply to move the conversation to the point you want']);
    }
    if (since !== 0) {
      const what = since > 0 ? `${since} newer message${since === 1 ? '' : 's'}` : 'been edited';
      return refused('CONVERSATION_CHANGED', `the conversation has ${what} since the rewind`,
        'Restoring the pre-rewind copy would discard them, so nothing was changed',
        ['Fork the session to keep the current conversation, then rewind or undo in the fork']);
    }
    if (!local.restoreBefore(undoSnapshotId)) {
      return refused('UNDO_POINT_GONE', 'the undo snapshot is gone',
        'That rewind can no longer be undone; the conversation itself is unchanged',
        ['Use rewind.plan and rewind.apply to move the conversation to the point you want']);
    }
    service.anchorsRestored(undoSnapshotId);
    return { undone: true, sessionId, undoSnapshotId, refusal: null };
  };
}

/** Attach the rewind.plan, rewind.apply and rewind.undo handlers to their descriptors. Missing descriptor is a silent no-op. */
export function registerRewindGatewayMethods(catalog: GatewayMethodCatalog, service: UnifiedRewindService, undo: RewindUndoDeps = {}): void {
  const planDescriptor = catalog.get('rewind.plan');
  if (planDescriptor) catalog.register(planDescriptor, createRewindPlanHandler(service), { replace: true });

  const applyDescriptor = catalog.get('rewind.apply');
  if (applyDescriptor) catalog.register(applyDescriptor, createRewindApplyHandler(service), { replace: true });

  const undoDescriptor = catalog.get('rewind.undo');
  if (undoDescriptor) catalog.register(undoDescriptor, createRewindUndoHandler(service, undo), { replace: true });
}

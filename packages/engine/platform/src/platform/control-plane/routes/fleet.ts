/**
 * routes/fleet.ts
 *
 * `fleet.snapshot` / `fleet.list` gateway-method handlers (see CHANGELOG 1.0.0) over the
 * ALREADY daemon-resident `ProcessRegistry` (createProcessRegistry(),
 * ../../runtime/fleet/registry.ts:204, constructed + exposed on
 * RuntimeServices at ../../runtime/services.ts:712/:242). This is thin verb
 * registration, not new machinery: every call is a direct pass-through to
 * `registry.query()`, the registry's own cheap aggregate-on-read scan.
 *
 * Wired via `GatewayMethodCatalog.register(descriptor, handler)`, the SAME
 * mechanism the plugin API already uses (../../plugins/api.ts
 * `registerGatewayMethod`), rather than a new REST path in the external
 * `@goodvibes/engine/daemon-api` package or a change to
 * ../../daemon/http/router.ts (both out of this brief's file ownership).
 * The registered handler is reached over real HTTP today via the existing
 * generic invoke endpoint `POST /api/control-plane/methods/{methodId}/invoke`
 * (daemon-api/src/control-routes.ts `invokeGatewayMethod`).
 *
 * Descriptors live in ../method-catalog-control-core.ts (so
 * `buildOperatorContract` / api.md / contract-artifact generation see them
 * whether or not a handler has been attached yet); `registerFleetGatewayMethods`
 * below attaches the handler at RuntimeServices construction time
 * (../../runtime/services.ts, right after `processRegistry` exists).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type {
  FleetQueryFilter,
  ProcessKind,
  ProcessNode,
  ProcessRegistry,
  ProcessState,
} from '../../runtime/fleet/types.js';
import type { FleetArchiveView } from '../../runtime/fleet/archive.js';
import { FLEET_NODE_KINDS, FLEET_NODE_STATES } from '../../../events/fleet.js';
import { contractRawForWire } from '../../runtime/fleet/contract-wire.js';
import type { AttemptJudgment, AttemptPickResult, HeldMergeGroup } from '../../orchestration/types.js';
import { AttemptError } from '../../orchestration/attempts.js';
import { paginateItems } from '@goodvibes/engine/daemon-api';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireString } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';
import { summarizeError } from '../../utils/error-display.js';
import { randomUUID } from 'node:crypto';
import type { ApprovalRaiseService } from './approvals-raise.js';
import { observedAgentRef } from '../../runtime/fleet/adapters/observed.js';
import type { ObservedAgentRow } from '../../runtime/fleet/observed/source.js';
import { compareTarget, type TargetRef } from '../../utils/target-ref.js';

/**
 * `fleet.snapshot` payload cap: the registry's
 * `query()` is a cheap O(n) in-memory scan, but the wire response must not
 * grow unbounded with fleet size. Nodes beyond this cap are dropped (newest
 * activity first is NOT guaranteed here, see `truncated`/`totalCount` so a
 * caller that needs the full set knows to page via `fleet.list` instead).
 */
export const FLEET_SNAPSHOT_NODE_CAP = 2000;

export const FLEET_LIST_DEFAULT_LIMIT = 100;
export const FLEET_LIST_MAX_LIMIT = 500;


function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return undefined;
}

function readFleetQueryFilter(query: Record<string, unknown> | undefined): FleetQueryFilter | undefined {
  if (!query) return undefined;
  const rawKinds = asStringArray(query.kinds);
  const rawStates = asStringArray(query.states);
  let kinds: ProcessKind[] | undefined;
  if (rawKinds) {
    const invalid = rawKinds.filter((k) => !(FLEET_NODE_KINDS as readonly string[]).includes(k));
    if (invalid.length > 0) {
      throw new GatewayVerbError(`Unknown fleet kind(s): ${invalid.join(', ')}`, 'INVALID_ARGUMENT', 400, 'kinds');
    }
    kinds = rawKinds as ProcessKind[];
  }
  let states: ProcessState[] | undefined;
  if (rawStates) {
    const invalid = rawStates.filter((s) => !(FLEET_NODE_STATES as readonly string[]).includes(s));
    if (invalid.length > 0) {
      throw new GatewayVerbError(`Unknown fleet state(s): ${invalid.join(', ')}`, 'INVALID_ARGUMENT', 400, 'states');
    }
    states = rawStates as ProcessState[];
  }
  if (!kinds && !states) return undefined;
  return { ...(kinds ? { kinds } : {}), ...(states ? { states } : {}) };
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new GatewayVerbError(`Invalid limit: ${String(raw)}`, 'INVALID_ARGUMENT', 400, 'limit');
  }
  return Math.min(Math.floor(n), max);
}

/** Structural dep, only the read surface `fleet.*` needs. */
export type FleetQueryOnlyRegistry = Pick<ProcessRegistry, 'query'>;

/**
 * A node as it leaves the daemon. `raw` is the source record. For a background
 * process's stdout and command line, a foreign agent's arguments or an
 * automation's prompt it can hold unredacted output, so it stays in-process.
 * The terminal reads two things back from the wire and nothing else: the
 * contract views behind contract, group and unit rows (they hold plan,
 * criteria and unit state, no process output), and an agent's `contractRole`.
 * Those are the only parts of `raw` that travel, and the contract view travels
 * once, on the contract node (runtime/fleet/contract-wire.ts).
 */
const CONTRACT_RAW_KINDS: ReadonlySet<ProcessKind> = new Set<ProcessKind>(['contract', 'contract-group', 'contract-unit']);

function toWireNode(node: ProcessNode): ProcessNode {
  const { raw, ...wire } = node;
  if (CONTRACT_RAW_KINDS.has(node.kind) && raw !== undefined) {
    const wireRaw = contractRawForWire(node);
    return wireRaw === undefined ? wire : { ...wire, raw: wireRaw };
  }
  if (node.kind === 'agent' && typeof raw === 'object' && raw !== null) {
    const contractRole = (raw as { contractRole?: unknown }).contractRole;
    if (contractRole !== undefined) return { ...wire, raw: { contractRole } };
  }
  return wire;
}

export function createFleetSnapshotHandler(registry: FleetQueryOnlyRegistry): GatewayMethodHandler {
  return (invocation) => {
    const filter = readFleetQueryFilter(readInvocationParams(invocation));
    const snapshot = registry.query(filter);
    const truncated = snapshot.nodes.length > FLEET_SNAPSHOT_NODE_CAP;
    const nodes = (truncated
      ? snapshot.nodes.slice(0, FLEET_SNAPSHOT_NODE_CAP)
      : snapshot.nodes).map(toWireNode);
    return {
      capturedAt: snapshot.capturedAt,
      nodes,
      truncated,
      totalCount: snapshot.nodes.length,
    };
  };
}

export function createFleetListHandler(registry: FleetQueryOnlyRegistry): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const filter = readFleetQueryFilter(params);
    const limit = clampLimit(params.limit, FLEET_LIST_DEFAULT_LIMIT, FLEET_LIST_MAX_LIMIT);
    const rawCursor = typeof params.cursor === 'string' ? params.cursor : null;
    const snapshot = registry.query(filter);
    // Sort key and recovery key MUST agree (mirrors sessions.search's
    // sortSessions-then-paginateItems pattern in session-search.ts): the array
    // is sorted newest-first by startedAt (id tiebreak for determinism when
    // two nodes share a timestamp, or neither has started), and paginateItems
    // is handed that SAME startedAt extractor with { descending: true }. A
    // node's `startedAt` is optional (not-yet-started processes), so absent
    // values are normalized to 0 for both the sort and the recovery key,
    // otherwise `paginateItems`' deleted-cursor recovery (which does a
    // findIndex assuming the array is actually ordered by the field it is
    // given) would search a startedAt-ordered predicate over an array that
    // was really sorted by id, silently skipping or repeating nodes once a
    // process is gc'd between pages.
    const startedAtOf = (node: ProcessNode): number => node.startedAt ?? 0;
    const sorted = [...snapshot.nodes].sort((a, b) => startedAtOf(b) - startedAtOf(a) || a.id.localeCompare(b.id));
    const page = paginateItems(
      sorted,
      limit,
      rawCursor,
      (node) => node.id,
      startedAtOf,
      { descending: true },
    );
    if ('error' in page) {
      throw new GatewayVerbError(page.error, 'INVALID_CURSOR', 400);
    }
    return {
      items: page.items.map(toWireNode),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      capturedAt: snapshot.capturedAt,
    };
  };
}

/** Registry surface for the archive verbs, optional so a runtime without the archive layer degrades honestly. */
export type FleetArchiveCapableRegistry = FleetQueryOnlyRegistry & Partial<FleetArchiveView>;

/** Registry surface fleet.observed.steer needs, read one node, steer it. */
export type FleetSteerCapableRegistry = Pick<ProcessRegistry, 'getNode' | 'steer'>;

/** The approval broker slice a steer asks through: the same broker tool calls ask through. */
export type FleetSteerApprovals = Pick<ApprovalRaiseService, 'raiseApproval'>;

/** How long a steer waits for the owner's answer before it is refused unsent. */
const STEER_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Whether `current` is still the observed process the owner was shown in
 * `shown`: the same process (pid with start time, pane, kind, directory and
 * command line) when it could be told apart, otherwise the same pid, agent kind
 * and tmux pane.
 */
function sameObservedProcess(shown: ProcessNode, shownRef: TargetRef | null, current: ProcessNode | null): boolean {
  if (!current || current.kind !== 'observed-external') return false;
  if (shownRef) {
    const currentRef = observedAgentRef(current);
    return currentRef !== null && compareTarget(shownRef, currentRef).length === 0;
  }
  const before = shown.raw as ObservedAgentRow | undefined;
  const now = current.raw as ObservedAgentRow | undefined;
  if (!before || !now) return false;
  const pane = (row: ObservedAgentRow): string | null => row.steer.kind === 'tmux' ? row.steer.paneId : null;
  return before.pid === now.pid && before.externalKind === now.externalKind && pane(before) === pane(now);
}

/**
 * fleet.observed.steer handler, the drill-in steer of an observed foreign
 * agent. Scoped to 'observed-external' rows by construction: an unknown id is a
 * 404, and steering a non-observed kind through this verb is refused (400) so it
 * can never become a back door to a native agent's steer path.
 *
 * The foreign agent runs with its own permissions, outside this daemon's gate,
 * so typing into it is put to the owner through the approval broker: one ask
 * naming the session, its directory, the exact text and whether it is
 * submitted. "Always" for that session is held in memory until the daemon
 * stops, against that exact process (pid, start time, pane, kind, directory
 * and command line): a new process given the same pid is asked about again. Without `submit: true` the text is typed and left for the person at
 * the pane; no Enter is sent. With no approval broker composed, nothing is sent.
 */
export function createFleetObservedSteerHandler(
  registry: FleetSteerCapableRegistry,
  approvals?: FleetSteerApprovals,
): GatewayMethodHandler {
  // "Always" is kept against the exact process (pid with its start time, pane,
  // kind, directory and command line), so a later process given the same pid
  // is asked about afresh.
  const grantedSessions = new Map<string, TargetRef>();
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const id = requireString(params, 'id');
    const text = typeof params.text === 'string' ? params.text : '';
    if (!text) throw new GatewayVerbError('text is required: a non-empty string', 'INVALID_ARGUMENT', 400, 'text');
    const submit = params.submit === true;
    const node = registry.getNode(id);
    if (!node) throw new GatewayVerbError(`No fleet node ${id} on this daemon.`, 'FLEET_NODE_NOT_FOUND', 404);
    if (node.kind !== 'observed-external') {
      throw new GatewayVerbError('fleet.observed.steer steers only observed-external rows.', 'INVALID_ARGUMENT', 400, 'id');
    }
    const observedProcess = observedAgentRef(node);
    const granted = grantedSessions.get(id);
    if (granted && (!observedProcess || compareTarget(granted, observedProcess).length > 0)) grantedSessions.delete(id);
    if (!grantedSessions.has(id)) {
      if (!approvals) {
        return { queued: false, reason: 'nothing was sent: this daemon has no approval broker to ask the owner through' };
      }
      const directory = node.observed?.cwd ?? 'an unknown directory';
      const raised = await approvals.raiseApproval({
        request: {
          callId: `fleet-steer-${randomUUID()}`,
          tool: 'fleet.observed.steer',
          args: { session: id, agent: node.label, directory, text, submit },
          category: 'execute',
          analysis: {
            classification: 'fleet.observed.steer',
            riskLevel: 'high',
            summary: `Type into ${node.label} in ${directory}${submit ? ' and submit it' : ''}`,
            reasons: [
              `${node.label} was not started by GoodVibes and runs with its own permissions, outside this daemon's approvals.`,
              submit
                ? 'The text is submitted with Enter, which also answers any prompt waiting in that session.'
                : 'The text is typed only; nothing is submitted until someone presses Enter there.',
            ],
            target: `${node.label} (${id}) in ${directory}`,
            sideEffects: [submit ? 'types the text into the session and submits it' : 'types the text into the session without submitting it'],
          },
          // Offered only for a process that can be told apart from a later one with its pid.
          rememberOptions: observedProcess ? [{
            tier: 'session',
            label: `Always allow typing into this ${node.label} session`,
            detail: `Until the daemon stops or this process ends, steers to ${id} are not asked again.`,
          }] : [],
        },
        ...(invocation.signal ? { signal: invocation.signal } : {}),
        metadata: { fleetNodeId: id, ...(invocation.context.principalId ? { requestedBy: invocation.context.principalId } : {}) },
        timeoutMs: STEER_APPROVAL_TIMEOUT_MS,
      });
      const decision = await raised.decision;
      if (!decision.approved) {
        return {
          queued: false,
          declined: true,
          reason: `nothing was sent: the owner did not approve typing into ${node.label}${decision.reason ? ` (${decision.reason})` : ''}`,
        };
      }
      // The approval names the process the owner was shown; a different one now under this id gets nothing.
      if (!sameObservedProcess(node, observedProcess, registry.getNode(id))) {
        return { queued: false, reason: 'nothing was sent: the session changed while the approval was pending' };
      }
      if (observedProcess && (decision.rememberTier !== undefined || decision.remember === true)) grantedSessions.set(id, observedProcess);
    }
    const result = registry.steer(id, text, { submit });
    if (result.queued === 'partial') {
      return { queued: 'partial', submitted: result.sent.includes('Enter'), sent: [...result.sent], failed: result.failed, reason: result.reason };
    }
    return result.queued
      ? { queued: true, submitted: submit, messageId: result.messageId }
      : { queued: false, reason: result.reason };
  };
}

function requireArchive<K extends keyof FleetArchiveView>(
  registry: FleetArchiveCapableRegistry,
  method: K,
): FleetArchiveView[K] {
  const fn = registry[method];
  if (!fn) {
    throw new GatewayVerbError('This runtime has no fleet archive layer.', 'UNSUPPORTED', 501);
  }
  return fn as FleetArchiveView[K];
}

export function createFleetArchiveHandler(registry: FleetArchiveCapableRegistry): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    if (!id) throw new GatewayVerbError('id is required', 'INVALID_ARGUMENT', 400, 'id');
    return requireArchive(registry, 'archive')(id);
  };
}

export function createFleetUnarchiveHandler(registry: FleetArchiveCapableRegistry): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    if (!id) throw new GatewayVerbError('id is required', 'INVALID_ARGUMENT', 400, 'id');
    return { restored: requireArchive(registry, 'unarchive')(id) };
  };
}

export function createFleetArchiveFinishedHandler(registry: FleetArchiveCapableRegistry): GatewayMethodHandler {
  return () => ({ archivedCount: requireArchive(registry, 'archiveFinished')() });
}

export function createFleetArchivedListHandler(registry: FleetArchiveCapableRegistry): GatewayMethodHandler {
  return () => {
    const snapshot = requireArchive(registry, 'listArchived')();
    return { capturedAt: snapshot.capturedAt, nodes: snapshot.nodes.map(toWireNode) };
  };
}

/**
 * The best-of-N surface the fleet verbs need, the orchestration engine's held-
 * merge methods. Optional at registration: a runtime with no orchestration
 * engine simply doesn't register the fleet.attempts.* verbs (graceful degrade).
 */
export interface FleetAttemptsController {
  /** Held-merge groups: all, one workstream's, or (with `groupId`) only the group named, so only it is diffed. */
  listHeldMergeGroups(workstreamId?: string, groupId?: string): Promise<HeldMergeGroup[]>;
  /** The task-graph snapshot (fleet.graph.get), nodes/edges/pool/stalled tells. Optional for narrower embeds. */
  getGraphSnapshot?(workstreamId: string): import('../../orchestration/graph-dynamics.js').WorkstreamGraphSnapshot | null;
  pickAttemptWinner(groupId: string, winnerItemId: string): Promise<AttemptPickResult>;
  proposeAttemptWinner(groupId: string): Promise<AttemptJudgment>;
  /** Conflict surface (optional, narrower embeds may wire attempts without conflicts). */
  listWorkstreams?(): ReadonlyArray<{ readonly id: string; readonly items: readonly ConflictWorkItemSlice[] }>;
  stampConflictSession?(itemId: string, sessionId: string): boolean;
  retryItemIntegration?(itemId: string): Promise<'merged' | 'conflict' | 'not-conflicted'>;
}

/** Map an AttemptError to an honest wire status: a missing judge is 501, every other precondition miss is 409. */
function attemptGatewayError(error: unknown): never {
  if (error instanceof AttemptError) {
    if (error.reason === 'judge-unavailable') {
      throw new GatewayVerbError(error.message, 'UNSUPPORTED', 501);
    }
    throw new GatewayVerbError(error.message, 'FAILED_PRECONDITION', 409);
  }
  throw error;
}

export function createFleetAttemptsListHandler(controller: FleetAttemptsController): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const workstreamId = typeof params.workstreamId === 'string' && params.workstreamId.length > 0 ? params.workstreamId : undefined;
    return { groups: await controller.listHeldMergeGroups(workstreamId) };
  };
}

export function createFleetAttemptsPickHandler(controller: FleetAttemptsController): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const groupId = typeof params.groupId === 'string' ? params.groupId.trim() : '';
    const winnerItemId = typeof params.winnerItemId === 'string' ? params.winnerItemId.trim() : '';
    if (!groupId) throw new GatewayVerbError('groupId is required', 'INVALID_ARGUMENT', 400, 'groupId');
    if (!winnerItemId) throw new GatewayVerbError('winnerItemId is required', 'INVALID_ARGUMENT', 400, 'winnerItemId');
    // ONE-act pick: without confirm this is the structured confirm PREVIEW,
    // the group (candidates, diffs, any judge proposal) comes back with the
    // refusal so a surface completes choice -> confirm -> applied through this
    // single verb, no list->diff->pick-id transcription ceremony. confirm:true
    // applies (merge winner through the integration lane, clean the losers).
    if (params.confirm !== true) {
      const groups = await controller.listHeldMergeGroups(undefined, groupId);
      const group = groups.find((candidate) => candidate.groupId === groupId);
      if (!group) throw new GatewayVerbError(`Unknown attempt group: ${groupId}`, 'FAILED_PRECONDITION', 409);
      if (!group.candidates.some((candidate) => candidate.itemId === winnerItemId && candidate.state === 'held-merge')) {
        throw new GatewayVerbError(`Item ${winnerItemId} is not a held candidate of group ${groupId}`, 'FAILED_PRECONDITION', 409);
      }
      return { applied: false, groupId, winnerItemId, requiresConfirm: true, group };
    }
    try {
      const result = await controller.pickAttemptWinner(groupId, winnerItemId);
      return { applied: true, ...result };
    } catch (error) {
      return attemptGatewayError(error);
    }
  };
}

// ── fleet.conflicts.*, merge-conflict rows and their one-action resolution ──

/** The conflicted-item slice the conflicts verbs read (the engine satisfies it structurally). */
export interface ConflictWorkItemSlice {
  readonly id: string;
  readonly title: string;
  readonly mergeState?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly worktreeBranch?: string | undefined;
  readonly conflictFiles?: readonly string[] | undefined;
  readonly conflictSessionId?: string | undefined;
}

export interface FleetConflictsDeps {
  readonly listWorkstreams: () => ReadonlyArray<{ readonly id: string; readonly items: readonly ConflictWorkItemSlice[] }>;
  readonly stampConflictSession: (itemId: string, sessionId: string) => boolean;
  /**
   * Whether a previously stamped resolution session is still running. When it
   * is, `fleet.conflicts.resolve` is refused (409) with that session's id instead of
   * starting a second agent in the same kept tree. Absent, a stamp alone never blocks a
   * retry (an abandoned session must stay replaceable).
   */
  readonly isSessionLive?: (sessionId: string) => boolean;
  /** Attempt the item's integration merge again; absent, `fleet.conflicts.retry` is not registered. */
  readonly retryIntegration?: (itemId: string) => Promise<'merged' | 'conflict' | 'not-conflicted'>;
  /**
   * Items a resolve is starting a session for, or a retry is merging: one claim set shared by the resolve and
   * retry handlers built from the same deps, so a retry never merges and reclaims a tree a session is being started
   * in, and a resolve never starts a session in a tree a retry is merging. Absent, each handler keeps its own.
   */
  readonly resolutionClaims?: Set<string>;
  /** Stops a resolution session that started but could not be stamped on its item (the conflict ended meanwhile). */
  readonly stopResolutionSession?: (sessionId: string) => Promise<void>;
  /**
   * Start the seeded resolution session INSIDE the kept tree (the CI
   * fix-session machinery): the seed carries the tree path, branch, and the
   * structured conflict list. Resolves to the REAL session id, or an honest error.
   */
  readonly startResolutionSession: (seed: {
    readonly workstreamId: string;
    readonly itemId: string;
    readonly title: string;
    readonly worktreePath: string;
    readonly branch: string | undefined;
    readonly files: readonly string[];
  }) => Promise<{ sessionId: string } | { error: string }>;
}

function collectConflicts(deps: FleetConflictsDeps, workstreamId?: string): Array<{
  workstreamId: string; itemId: string; title: string; worktreePath: string;
  branch?: string | undefined; files: readonly string[]; resolutionSessionId?: string | undefined;
}> {
  const out: ReturnType<typeof collectConflicts> = [];
  for (const workstream of deps.listWorkstreams()) {
    if (workstreamId && workstream.id !== workstreamId) continue;
    for (const item of workstream.items) {
      if (item.mergeState !== 'conflict' || !item.worktreePath) continue;
      out.push({
        workstreamId: workstream.id,
        itemId: item.id,
        title: item.title,
        worktreePath: item.worktreePath,
        branch: item.worktreeBranch,
        files: item.conflictFiles ?? [],
        resolutionSessionId: item.conflictSessionId,
      });
    }
  }
  return out;
}

export function createFleetConflictsListHandler(deps: FleetConflictsDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const workstreamId = typeof params.workstreamId === 'string' && params.workstreamId.length > 0 ? params.workstreamId : undefined;
    return { conflicts: collectConflicts(deps, workstreamId) };
  };
}

export function createFleetConflictsResolveHandler(deps: FleetConflictsDeps): GatewayMethodHandler {
  // Held across the await so a double click or a retry after a slow response
  // cannot start a second agent in the same worktree before the first is stamped.
  const inFlight = deps.resolutionClaims ?? new Set<string>();
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const itemId = typeof params.itemId === 'string' ? params.itemId.trim() : '';
    if (!itemId) throw new GatewayVerbError('itemId is required', 'INVALID_ARGUMENT', 400, 'itemId');
    const conflict = collectConflicts(deps).find((candidate) => candidate.itemId === itemId);
    if (!conflict) {
      throw new GatewayVerbError(`Item ${itemId} has no unresolved merge conflict`, 'FAILED_PRECONDITION', 409);
    }
    if (inFlight.has(itemId)) {
      throw new GatewayVerbError(
        `A resolution session for item ${itemId} is already starting, or its merge is being retried. Read fleet.conflicts.list once that finishes.`,
        'FAILED_PRECONDITION',
        409,
      );
    }
    if (conflict.resolutionSessionId && deps.isSessionLive?.(conflict.resolutionSessionId)) {
      throw new GatewayVerbError(
        `Item ${itemId} is already being resolved in session ${conflict.resolutionSessionId}. Open that session, or wait for it to finish before resolving again.`,
        'FAILED_PRECONDITION',
        409,
      );
    }
    inFlight.add(itemId);
    try {
      const started = await deps.startResolutionSession({
        workstreamId: conflict.workstreamId,
        itemId: conflict.itemId,
        title: conflict.title,
        worktreePath: conflict.worktreePath,
        branch: conflict.branch,
        files: conflict.files,
      });
      if ('error' in started) {
        throw new GatewayVerbError(`Resolution session did not start: ${started.error}`, 'FAILED_PRECONDITION', 409);
      }
      // The REAL session id is stamped onto the item (the CI fix-flow stamping
      // contract), so the conflict row names where the resolution is happening.
      // A stamp that is refused means the conflict ended while the session
      // started (its merge landed, or the item ended): the session must not go
      // on working in a tree that may be reclaimed, so it is stopped.
      if (!deps.stampConflictSession(itemId, started.sessionId)) {
        let stopped = 'it was stopped';
        try { await deps.stopResolutionSession?.(started.sessionId); }
        catch (error) { stopped = `stopping it failed (${summarizeError(error)}); stop session ${started.sessionId} by hand`; }
        if (deps.stopResolutionSession === undefined) stopped = `stop session ${started.sessionId} by hand`;
        throw new GatewayVerbError(
          `Item ${itemId}'s merge conflict ended while its resolution session ${started.sessionId} was starting, so the session has nothing to resolve; ${stopped}. Read fleet.conflicts.list.`,
          'CONFLICT_RESOLVED_ELSEWHERE',
          409,
          'itemId',
        );
      }
      return { itemId, sessionId: started.sessionId, worktreePath: conflict.worktreePath, files: conflict.files };
    } finally {
      inFlight.delete(itemId);
    }
  };
}

/**
 * `fleet.conflicts.retry`: the merge attempted again, for a conflict fixed by
 * hand or by a session whose own completion did not re-merge. The engine's
 * answer is returned as given.
 */
export function createFleetConflictsRetryHandler(
  deps: FleetConflictsDeps & Required<Pick<FleetConflictsDeps, 'retryIntegration'>>,
): GatewayMethodHandler {
  const claims = deps.resolutionClaims ?? new Set<string>();
  return async (invocation) => {
    const itemId = requireString(readInvocationParams(invocation), 'itemId');
    // The resolver's claim: a session being started for the item (or another retry) owns its tree right now.
    if (claims.has(itemId)) {
      throw new GatewayVerbError(
        `A resolution session for item ${itemId} is starting, or its merge is already being retried, so its merge was not retried now. Read fleet.conflicts.list once that finishes.`,
        'FAILED_PRECONDITION',
        409,
        'itemId',
      );
    }
    const conflict = collectConflicts(deps).find((candidate) => candidate.itemId === itemId);
    if (conflict?.resolutionSessionId && deps.isSessionLive?.(conflict.resolutionSessionId)) {
      throw new GatewayVerbError(
        `Item ${itemId} is still being resolved in session ${conflict.resolutionSessionId}, so its merge was not retried. Wait for that session to finish; its success retries the merge itself.`,
        'FAILED_PRECONDITION',
        409,
        'itemId',
      );
    }
    claims.add(itemId);
    try {
      return { itemId, outcome: await deps.retryIntegration(itemId) };
    } catch (error) {
      throw new GatewayVerbError(
        `The merge of item ${itemId} could not be attempted: ${summarizeError(error)}. The item is unchanged; read fleet.conflicts.list and retry.`,
        'INTEGRATION_FAILED',
        409,
      );
    } finally {
      claims.delete(itemId);
    }
  };
}

export function createFleetAttemptsJudgeHandler(controller: FleetAttemptsController): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const groupId = typeof params.groupId === 'string' ? params.groupId.trim() : '';
    if (!groupId) throw new GatewayVerbError('groupId is required', 'INVALID_ARGUMENT', 400, 'groupId');
    try {
      return await controller.proposeAttemptWinner(groupId);
    } catch (error) {
      return attemptGatewayError(error);
    }
  };
}

/**
 * Attach the `fleet.*` handlers to the descriptors
 * already registered (without a handler) from
 * ../method-catalog-fleet.ts's static builtin array. Call once, at
 * RuntimeServices construction time, after `processRegistry` exists.
 * A missing descriptor (contract/registration drift) is a silent no-op
 * rather than a throw, construction must never fail because a wire verb
 * failed to register; the operator-contract gates catch a real drift.
 */
/** fleet.graph.get, the surface-facing task graph of one workstream. */
export function createFleetGraphGetHandler(controller: FleetAttemptsController): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const workstreamId = typeof params.workstreamId === 'string' ? params.workstreamId.trim() : '';
    if (!workstreamId) {
      throw new GatewayVerbError('workstreamId is required', 'INVALID_ARGUMENT', 400, 'workstreamId');
    }
    const snapshot = controller.getGraphSnapshot?.(workstreamId) ?? null;
    if (!snapshot) {
      throw new GatewayVerbError(`No workstream ${workstreamId} on this daemon.`, 'WORKSTREAM_NOT_FOUND', 404);
    }
    return snapshot;
  };
}

export function registerFleetGatewayMethods(
  catalog: GatewayMethodCatalog,
  registry: FleetArchiveCapableRegistry & FleetSteerCapableRegistry,
  attempts?: FleetAttemptsController,
  steerApprovals?: FleetSteerApprovals,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('fleet.snapshot', createFleetSnapshotHandler(registry));
  attach('fleet.list', createFleetListHandler(registry));
  attach('fleet.observed.steer', createFleetObservedSteerHandler(registry, steerApprovals));
  attach('fleet.archive', createFleetArchiveHandler(registry));
  attach('fleet.unarchive', createFleetUnarchiveHandler(registry));
  attach('fleet.archiveFinished', createFleetArchiveFinishedHandler(registry));
  attach('fleet.archived.list', createFleetArchivedListHandler(registry));
  // fleet.attempts.* (best-of-N held-merge), registered only when an
  // orchestration engine is wired; absent, the verbs stay cataloged-but-
  // unhandled rather than a facade (graceful degrade, like the archive verbs).
  if (attempts) {
    attach('fleet.attempts.list', createFleetAttemptsListHandler(attempts));
    attach('fleet.attempts.pick', createFleetAttemptsPickHandler(attempts));
    attach('fleet.attempts.judge', createFleetAttemptsJudgeHandler(attempts));
    // The task-graph view: surfaces render the graph under the chain.
    attach('fleet.graph.get', createFleetGraphGetHandler(attempts));
  }
}

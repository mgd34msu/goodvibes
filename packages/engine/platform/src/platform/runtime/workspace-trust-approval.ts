/**
 * workspace-trust-approval.ts, how a headless daemon asks the workspace trust
 * question, and how the answer reaches the runs it hosts.
 *
 * The terminal app composes the trust gate at the permission machinery's final
 * ask layer and raises the question as a modal on its own screen. The daemon
 * has the same gate, `trustGatedAsk` next door, reading the same decision in
 * the user's workspace register the terminal app writes, and no screen to
 * raise anything on. Before this module it therefore
 * did neither: the gate was constructed, never loaded, never consulted, and no
 * hosted run passed through it.
 *
 * Two pieces close that:
 *
 *  1. `createWorkspaceTrustDecisionAsk` raises the trust question as an
 *     ordinary approval record. That is the whole point of the approval-raise
 *     path: a process with no screen states the question, publishes it on
 *     `approval-update`, and whichever surface is attached answers it. An explicitly approved
 *     record means "trusted", explicitly denied means "restricted", a real decision either way,
 *     persisted by the gate, and never asked again for this workspace.
 *
 *  2. `trustGatedApprovalRaiser` puts the gate in front of the raiser the
 *     permission manager asks through, and loads the persisted decision before
 *     consulting it. The load is here rather than in the composition root
 *     because `createRuntimeServices` is synchronous: a fire-and-forget load
 *     started at composition time can lose the race with the first hosted run,
 *     and losing it means re-asking a question the user already answered.
 *     `WorkspaceTrustManager.load()` is idempotent, so paying for it on every
 *     ask costs one already-resolved promise after the first.
 *
 * What the daemon does NOT do here is decide by default. An untrusted
 * workspace's hosted run neither runs as if trusted nor fails as if refused: it
 * asks, once. The question stays open until someone answers it (or the daemon
 * restarts, which cancels it); a request waits for it at most
 * WORKSPACE_TRUST_ASK_TIMEOUT_MS after it was raised, and after that every
 * non-read request is refused at once, saying the question is still open,
 * while reads keep working. One question per workspace, never one per attempt.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { assertPermissionActive, awaitPermission } from '../permissions/cancellation.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../permissions/prompt.js';
import type { ApprovalBroker } from '../control-plane/approval-broker.js';
import { trustGatedAsk, type TrustGateOptions, type WorkspaceTrustLevel, type WorkspaceTrustManager } from './workspace-trust.js';

/**
 * The extra fields a raise carries beside the request itself, the attribution
 * routing/metadata a background-agent ask is stamped with before it reaches the
 * broker. The gate only reads `request.category`, so these ride around it.
 */
export interface ApprovalRaiseExtras {
  /** Per-consumer lifetime, never part of the persisted/wire request. */
  readonly signal?: AbortSignal | undefined;
  readonly routeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  /** The session the ask is raised under: it stays that session's ask, never another's. */
  readonly sessionId?: string | undefined;
  /** Expiry for a raised ask; the trust question sets one, tool asks do not. */
  readonly timeoutMs?: number | undefined;
}

/** Raise an ask and wait for the answer. Matches the platform's ApprovalRaiser seam. */
export type ApprovalRaise = (
  input: { readonly request: PermissionPromptRequest } & ApprovalRaiseExtras,
) => Promise<PermissionPromptDecision>;

/**
 * How long requests wait on the open trust question, counted from when it was
 * raised. The question itself stays open after this; only the waiting stops.
 *
 * A hosted run blocked on a question nobody is there to answer is a run that
 * never finishes, and an unattended daemon is the normal case, not the edge
 * one. Ten minutes is long enough for someone who is at a surface to see the
 * ask and answer it, and short enough that an unattended run gets a reason
 * instead of hanging; later attempts get that reason at once.
 */
export const WORKSPACE_TRUST_ASK_TIMEOUT_MS = 10 * 60 * 1000;

/** No explicit, correlated operator choice was recorded; leave trust undecided. */
export class WorkspaceTrustDecisionUnsettledError extends Error {
  readonly code = 'WORKSPACE_TRUST_DECISION_UNSETTLED';
  constructor() {
    super('Workspace trust was not explicitly answered; this run is refused and the workspace remains undecided.');
    this.name = 'WorkspaceTrustDecisionUnsettledError';
  }
}

export interface WorkspaceTrustDecisionAskDeps {
  /** Raise once, then read the current record after its ordinary decision settles. */
  readonly broker: Pick<ApprovalBroker, 'raiseApproval' | 'getApproval'>;
  /** The workspace the question is about, it names the directory being trusted. */
  readonly workingDirectory: string;
  /** An expiry for the question itself; absent, it stays open until answered or the daemon restarts. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Build the `requestTrustDecision` callback `trustGatedAsk` calls when a
 * workspace has no decision yet.
 *
 * The question is raised as a `read`-category request on purpose: it is the
 * trust question itself, raised BY the gate, and routing it back through the
 * gate would ask the gate to decide whether it may ask.
 */
export function createWorkspaceTrustDecisionAsk(
  deps: WorkspaceTrustDecisionAskDeps,
): () => Promise<WorkspaceTrustLevel> {
  return async () => {
    const request: PermissionPromptRequest = {
      callId: `workspace-trust-${randomUUID().slice(0, 8)}`,
      tool: 'workspace-trust',
      args: { workspace: deps.workingDirectory },
      category: 'read',
      analysis: {
        classification: 'workspace-trust',
        riskLevel: 'high',
        summary: `Trust the workspace ${deps.workingDirectory}?`,
        reasons: [
          `A run hosted by this daemon wants to write, execute, or delegate in "${deps.workingDirectory}", which has no trust decision recorded.`,
          'Approving trusts the folder, and this question is not asked for it again. Trusting it lets its own hooks and MCP servers run and lets GoodVibes change files in it. It approves nothing: each action still follows your setting for when GoodVibes asks.',
          'Denying restricts the folder: GoodVibes can still read it, but writes, commands and delegation there are refused, and the folder\'s own hooks and MCP servers stay off.',
        ],
        target: deps.workingDirectory,
        targetKind: 'path',
        blastRadius: 'local',
      },
    };
    try {
      const raised = await deps.broker.raiseApproval({
        request,
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        metadata: { source: 'workspace-trust', workspace: deps.workingDirectory },
      });
      const { id, callId, createdAt } = raised.approval;
      await raised.decision;
      // The raised object is a pending snapshot, not evidence of an answer.
      const record = deps.broker.getApproval(id);
      if (!record || record.id !== id || record.callId !== callId || record.createdAt !== createdAt
        || record.request.callId !== callId || record.request.tool !== 'workspace-trust'
        || record.request.category !== 'read' || record.request.args['workspace'] !== deps.workingDirectory) {
        throw new WorkspaceTrustDecisionUnsettledError();
      }
      const decision = record.decision;
      if (record.status === 'approved' && decision?.approved === true && decision.disposition === 'approved') return 'trusted';
      if (record.status === 'denied' && decision?.approved === false && decision.disposition === 'denied') return 'restricted';
      // A refusal of this run is not an operator choice about future runs.
      // In particular, no legacy boolean, timeout, cancellation, amendment or
      // remembered-rule sweep can permanently decide workspace trust.
      throw new WorkspaceTrustDecisionUnsettledError();
    } catch (error) {
      // Cancelled, or the broker failed. Say so and leave the workspace
      // undecided, the next request asks again rather than inheriting a
      // decision nobody made.
      logger.warn('Workspace trust question could not be answered; this run is refused and the workspace stays undecided', {
        workspace: deps.workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/** The slice of the trust manager this seam uses. */
export type TrustGateManager =
  & Pick<WorkspaceTrustManager, 'isCategoryAllowed' | 'isDecided' | 'trustQuestion'>
  & { readonly workspaceRoot?: string; load(): Promise<void> };

/**
 * Wrap an approval raiser with the workspace trust gate.
 *
 * Layering matches the terminal app's: the gate is the outer ask, the broker
 * raise is the inner one, and the permission manager's own layers (mode,
 * policy, session cache, durable rules) still run before either. A trusted
 * workspace is exactly as permissive as it was; a restricted one refuses
 * non-read categories without asking, because that is what the user chose.
 *
 * `routeId`/`metadata` reach the inner raise unchanged. The gate's own
 * signature carries only the request, so the extras are held against the
 * request object for the duration of the call rather than in a shared slot a
 * concurrent ask could overwrite.
 */
export function trustGatedApprovalRaiser(
  manager: TrustGateManager,
  raise: ApprovalRaise,
  requestTrustDecision: () => Promise<WorkspaceTrustLevel>,
  options: TrustGateOptions = {},
): ApprovalRaise {
  const extrasByRequest = new WeakMap<PermissionPromptRequest, ApprovalRaiseExtras>();
  const gated = trustGatedAsk(
    manager,
    (request) => {
      const extras = extrasByRequest.get(request) ?? {};
      assertPermissionActive(extras.signal);
      return raise({ request, ...extras });
    },
    requestTrustDecision,
    options,
  );
  return async (input) => {
    const signal = input.signal;
    assertPermissionActive(signal);
    // One private identity per participation, even if callers reuse the same
    // request object while waiting on the shared workspace trust decision.
    const request = { ...input.request };
    extrasByRequest.set(request, { routeId: input.routeId, metadata: input.metadata, signal, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) });
    // Idempotent, and awaited on every ask rather than once at composition:
    // see the module header for why the composition root cannot await it.
    return awaitPermission(async () => {
      await manager.load();
      assertPermissionActive(signal);
      return gated(request);
    }, signal);
  };
}

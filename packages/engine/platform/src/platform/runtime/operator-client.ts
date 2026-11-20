import type {
  ControlPlaneRecentEvent,
  RegisterSharedSessionInput,
  SharedApprovalRecord,
  SharedSessionInputRecord,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionRegisterResult,
  SharedSessionSubmission,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from '../control-plane/index.js';
import type { ApprovalActionInput } from '../control-plane/approval-broker.js';
import type { ResolveSharedApprovalInput } from '../control-plane/approval-broker-owner.js';
import type { TransitionOutcome } from '../control-plane/approval-lifecycle.js';
import type { RequestSharedApprovalInput } from '../control-plane/index.js';
import type { PermissionPromptDecision } from '../permissions/prompt.js';
import { buildAuthInspectionSnapshot, type AuthInspectionSnapshot } from './auth/inspection.js';
import { buildProviderAccountSnapshot, type ProviderAccountSnapshot } from './provider-accounts/registry.js';
import type { ProviderRuntimeSnapshot, ProviderUsageSnapshot } from '../providers/runtime-snapshot.js';
import { getProviderRuntimeSnapshot, getProviderUsageSnapshot, listProviderRuntimeSnapshots } from '../providers/runtime-snapshot.js';
import type { OperatorClientServices } from './foundation-services.js';
import type { RuntimeTask } from './store/domains/tasks.js';
import type { UiControlPlaneSnapshot, UiSessionSnapshot, UiTasksSnapshot } from './ui-read-models.js';
import type { UiRuntimeEvents } from './ui-events.js';
import type { ShellPathService } from './shell-paths.js';

export interface OperatorControlPlaneSnapshot extends UiControlPlaneSnapshot {}

export interface OperatorProvidersSnapshot {
  readonly providerIds: readonly string[];
  readonly runtimeSnapshots: readonly ProviderRuntimeSnapshot[];
  readonly accountSnapshot: ProviderAccountSnapshot;
  readonly authInspection: AuthInspectionSnapshot;
}

export interface OperatorSessionsClient {
  current(): UiSessionSnapshot;
  list(limit?: number): readonly SharedSessionRecord[];
  get(sessionId: string): SharedSessionRecord | null;
  messages(sessionId: string, limit?: number): readonly SharedSessionMessage[];
  inputs(sessionId: string, limit?: number, options?: { readonly state?: string | undefined; readonly since?: number | undefined }): readonly SharedSessionInputRecord[];
  ensureSession(input?: OperatorSessionEnsureInput): Promise<SharedSessionRecord>;
  register(input: RegisterSharedSessionInput): Promise<SharedSessionRegisterResult>;
  close(sessionId: string): Promise<SharedSessionRecord | null>;
  reopen(sessionId: string): Promise<SharedSessionRecord | null>;
  /** Detach a surface's participant/route from a session without closing it
   * (detach != close != kill). Idempotent; see sessions.detach. */
  detach(sessionId: string, surfaceId: string): Promise<SharedSessionRecord | null>;
  /** Permanently remove a session (delete != close). Requires the
   * session already closed, see sessions.delete. */
  delete(sessionId: string): Promise<'deleted' | 'not-found' | 'active'>;
  bindAgent(sessionId: string, agentId: string): Promise<SharedSessionRecord | null>;
  submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  steerMessage(input: SteerSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  followUpMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  cancelInput(sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null>;
  /** A live surface marks a collected input delivered (`consumed:false`) or
   * consumed/completed (`consumed:true`), optionally naming the agent that is
   * answering it (`agentId`, which binds the reply) and that agent's finished
   * output (`answer`/`status`, reported with `consumed:true`).
   * See sessions.inputs.deliver. */
  deliverInput(sessionId: string, inputId: string, options?: SurfaceInputDeliveryOptions): Promise<SharedSessionInputRecord | null>;
}

/**
 * What a live surface reports when it hands a collected input back.
 *
 * `agentId` names the agent answering THIS input, the pairing only the
 * surface running the loop knows, and the thing that binds a channel reply.
 * `answer`/`status` carry that agent's finished output once the surface's turn
 * ends, so the daemon can write it into the session and deliver it.
 */
export interface SurfaceInputDeliveryOptions {
  readonly consumed?: boolean | undefined;
  /** Take the input before working on it; refused when another surface already holds it. */
  readonly claim?: boolean | undefined;
  readonly agentId?: string | undefined;
  /** The surface process running that agent (`<host>:<pid>:<nonce>`), so a restarted surface can fail what a process that is gone was answering. */
  readonly surfaceInstance?: string | undefined;
  readonly answer?: string | undefined;
  readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
  /** The surface's claim token on the input (`metadata.claimEpoch` of its granted claim): renews the claim with `claim`, and must be current on every other report. */
  readonly claimEpoch?: number | undefined;
}

export interface OperatorTasksClient {
  snapshot(): UiTasksSnapshot;
  list(limit?: number): readonly RuntimeTask[];
  get(taskId: string): RuntimeTask | null;
  running(): readonly RuntimeTask[];
}

export interface OperatorApprovalsClient {
  list(limit?: number): readonly SharedApprovalRecord[];
  get(approvalId: string): SharedApprovalRecord | null;
  request(input: RequestSharedApprovalInput): Promise<PermissionPromptDecision>;
  /** Every action names the revision it acted on (`expectedRevision`); a stale or settled one is refused with the current record. */
  claim(approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome>;
  resolve(approvalId: string, input: ResolveSharedApprovalInput): Promise<TransitionOutcome>;
  approve(approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome>;
  deny(approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome>;
  cancel(approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome>;
  update(
    approvalId: string,
    input: {
      readonly actor: string;
      readonly actorSurface?: string | undefined;
      readonly note?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<TransitionOutcome>;
}

export type OperatorSessionEnsureInput = NonNullable<Parameters<OperatorClientServices['sessionBroker']['ensureSession']>[0]>;

export interface OperatorProvidersClient {
  listIds(): readonly string[];
  runtimeSnapshots(): Promise<readonly ProviderRuntimeSnapshot[]>;
  runtimeSnapshot(providerId: string): Promise<ProviderRuntimeSnapshot | null>;
  usageSnapshot(providerId: string): Promise<ProviderUsageSnapshot | null>;
  snapshot(): Promise<OperatorProvidersSnapshot>;
  accountSnapshot(): Promise<ProviderAccountSnapshot>;
  authInspection(): Promise<AuthInspectionSnapshot>;
}

export interface OperatorControlPlaneClient {
  snapshot(): OperatorControlPlaneSnapshot;
  recentEvents(limit?: number): readonly ControlPlaneRecentEvent[];
}

export interface OperatorClient {
  readonly sessions: OperatorSessionsClient;
  readonly tasks: OperatorTasksClient;
  readonly approvals: OperatorApprovalsClient;
  readonly providers: OperatorProvidersClient;
  readonly controlPlane: OperatorControlPlaneClient;
  readonly events: UiRuntimeEvents;
  readonly shellPaths: ShellPathService;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.floor(limit));
}

function listTasksSnapshot(snapshot: UiTasksSnapshot, limit = 100): readonly RuntimeTask[] {
  return snapshot.tasks.slice(0, normalizeLimit(limit));
}

function getTaskSnapshot(snapshot: UiTasksSnapshot, taskId: string): RuntimeTask | null {
  return snapshot.tasks.find((task) => task.id === taskId) ?? null;
}

export function createOperatorClient(services: OperatorClientServices): OperatorClient {
  const sessions = {
    current: (): UiSessionSnapshot => services.readModels.session.getSnapshot(),
    list: (limit = 100): readonly SharedSessionRecord[] => services.sessionBroker.listSessions(normalizeLimit(limit)),
    get: (sessionId: string): SharedSessionRecord | null => services.sessionBroker.getSession(sessionId),
    messages: (sessionId: string, limit = 100): readonly SharedSessionMessage[] => services.sessionBroker.getMessages(sessionId, normalizeLimit(limit)),
    inputs: (sessionId: string, limit = 100, options?: { readonly state?: string | undefined; readonly since?: number | undefined }): readonly SharedSessionInputRecord[] =>
      (options && (options.state !== undefined || options.since !== undefined))
        ? services.sessionBroker.getInputsSince(sessionId, {
            ...(options.state !== undefined ? { state: options.state as SharedSessionInputRecord['state'] } : {}),
            ...(options.since !== undefined ? { since: options.since } : {}),
            limit: normalizeLimit(limit),
          })
        : services.sessionBroker.getInputs(sessionId, normalizeLimit(limit)),
    ensureSession: (input: Parameters<OperatorClientServices['sessionBroker']['ensureSession']>[0] = {}): Promise<SharedSessionRecord> => services.sessionBroker.ensureSession(input),
    register: (input: RegisterSharedSessionInput): Promise<SharedSessionRegisterResult> => services.sessionBroker.register(input),
    close: (sessionId: string): Promise<SharedSessionRecord | null> => services.sessionBroker.closeSession(sessionId),
    reopen: (sessionId: string): Promise<SharedSessionRecord | null> => services.sessionBroker.reopenSession(sessionId),
    detach: (sessionId: string, surfaceId: string): Promise<SharedSessionRecord | null> => services.sessionBroker.detachParticipant(sessionId, surfaceId),
    delete: (sessionId: string): Promise<'deleted' | 'not-found' | 'active'> => services.sessionBroker.deleteSession(sessionId),
    bindAgent: (sessionId: string, agentId: string): Promise<SharedSessionRecord | null> => services.sessionBroker.bindAgent(sessionId, agentId),
    submitMessage: (input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> => services.sessionBroker.submitMessage(input),
    steerMessage: (input: SteerSharedSessionMessageInput): Promise<SharedSessionSubmission> => services.sessionBroker.steerMessage(input),
    followUpMessage: (input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> => services.sessionBroker.followUpMessage(input),
    cancelInput: (sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null> => services.sessionBroker.cancelInput(sessionId, inputId),
    deliverInput: (sessionId: string, inputId: string, options: SurfaceInputDeliveryOptions = {}): Promise<SharedSessionInputRecord | null> => services.sessionBroker.markInputDelivered(sessionId, inputId, options),
  } satisfies OperatorSessionsClient;

  const tasks = {
    snapshot: (): UiTasksSnapshot => services.readModels.tasks.getSnapshot(),
    list: (limit = 100): readonly RuntimeTask[] => listTasksSnapshot(services.readModels.tasks.getSnapshot(), limit),
    get: (taskId: string): RuntimeTask | null => getTaskSnapshot(services.readModels.tasks.getSnapshot(), taskId),
    running: (): readonly RuntimeTask[] => services.readModels.tasks.getSnapshot().tasks.filter((task) => task.status === 'running'),
  } satisfies OperatorTasksClient;

  const approvals = {
    list: (limit = 100): readonly SharedApprovalRecord[] => services.approvalBroker.listApprovals(normalizeLimit(limit)),
    get: (approvalId: string): SharedApprovalRecord | null => services.approvalBroker.getApproval(approvalId),
    request: (input: RequestSharedApprovalInput): Promise<PermissionPromptDecision> => services.approvalBroker.requestApproval(input),
    claim: (approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome> => services.approvalBroker.claimApproval(approvalId, { actorSurface: 'operator', ...input }),
    resolve: (approvalId: string, input: ResolveSharedApprovalInput): Promise<TransitionOutcome> => services.approvalBroker.resolveApproval(approvalId, input),
    approve: (approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome> => services.approvalBroker.resolveApproval(approvalId, {
      actorSurface: 'operator', ...input, approved: true, disposition: 'approved',
    }),
    deny: (approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome> => services.approvalBroker.resolveApproval(approvalId, {
      actorSurface: 'operator', ...input, approved: false, disposition: 'denied',
    }),
    cancel: (approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome> => services.approvalBroker.cancelApproval(approvalId, { actorSurface: 'operator', ...input }),
    update: (approvalId: string, input: {
      readonly actor: string;
      readonly actorSurface?: string | undefined;
      readonly note?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    }): Promise<TransitionOutcome> => services.approvalBroker.recordRemoteUpdate(approvalId, input),
  } satisfies OperatorApprovalsClient;

  const providers = {
    listIds: (): readonly string[] => services.readModels.providers.getSnapshot().providerIds,
    runtimeSnapshots: (): Promise<readonly ProviderRuntimeSnapshot[]> => listProviderRuntimeSnapshots(services.providerRegistry),
    runtimeSnapshot: (providerId: string): Promise<ProviderRuntimeSnapshot | null> => getProviderRuntimeSnapshot(services.providerRegistry, providerId),
    usageSnapshot: (providerId: string): Promise<ProviderUsageSnapshot | null> => getProviderUsageSnapshot(services.providerRegistry, providerId),
    accountSnapshot: (): Promise<ProviderAccountSnapshot> => buildProviderAccountSnapshot({
      providerRegistry: services.providerRegistry,
      serviceRegistry: services.serviceRegistry,
      subscriptionManager: services.subscriptionManager,
      secretsManager: services.secretsManager,
    }),
    authInspection: (): Promise<AuthInspectionSnapshot> => buildAuthInspectionSnapshot({
      serviceRegistry: services.serviceRegistry,
      subscriptionManager: services.subscriptionManager,
      secretsManager: services.secretsManager,
    }),
    snapshot: async (): Promise<OperatorProvidersSnapshot> => {
      const [runtimeSnapshots, accountSnapshot, authInspection] = await Promise.all([
        listProviderRuntimeSnapshots(services.providerRegistry),
        buildProviderAccountSnapshot({
          providerRegistry: services.providerRegistry,
          serviceRegistry: services.serviceRegistry,
          subscriptionManager: services.subscriptionManager,
          secretsManager: services.secretsManager,
        }),
        buildAuthInspectionSnapshot({
          serviceRegistry: services.serviceRegistry,
          subscriptionManager: services.subscriptionManager,
          secretsManager: services.secretsManager,
        }),
      ]);
      return {
        providerIds: services.readModels.providers.getSnapshot().providerIds,
        runtimeSnapshots,
        accountSnapshot,
        authInspection,
      };
    },
  } satisfies OperatorProvidersClient;

  const controlPlane = {
    snapshot: (): OperatorControlPlaneSnapshot => services.readModels.controlPlane.getSnapshot(),
    recentEvents: (limit = 6): readonly ControlPlaneRecentEvent[] => services.readModels.controlPlane.getSnapshot().recentEvents.slice(0, normalizeLimit(limit)),
  } satisfies OperatorControlPlaneClient;

  return Object.freeze({
    sessions,
    tasks,
    approvals,
    providers,
    controlPlane,
    events: services.events,
    shellPaths: services.shellPaths,
  });
}

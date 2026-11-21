import type { FetchLike } from '@goodvibes/engine/transport-core';
import type { StreamEnd, StreamGap } from '@goodvibes/engine/transport-http';
import type { Page, Refusal } from '@goodvibes/engine/errors';
import type {
  ApprovalReading,
  ControlPlaneRecentEvent,
  ControlPlaneAuthSnapshot,
  SharedApprovalRecord,
  SharedSessionInputRecord,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionSubmissionReceipt,
} from '../../control-plane/index.js';
import type { RegisterSharedSessionInput, SharedSessionRegisterResult, SteerSharedSessionMessageInput } from '../../control-plane/index.js';
import type { ProviderRuntimeSnapshot, ProviderUsageSnapshot } from '../../providers/runtime-snapshot.js';
import type { RememberTier } from '../../permissions/approval-rules.js';
import type {
  TelemetryAggregates,
  TelemetryCapabilities,
  TelemetryFilter,
  TelemetryListResponse,
  TelemetryRecord,
  TelemetryRuntimeSnapshot,
  TelemetrySnapshot,
  TelemetryViewMode,
} from '../telemetry/api.js';
import type {
  DistributedNodeHostContract,
  DistributedPendingWork,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPeerTokenRecord,
  DistributedRuntimePairRequest,
  DistributedWorkPriority,
} from '../remote/distributed-runtime-types.js';
import type { RemoteBackendInvokeResult } from '../remote/host/backend-host.js';
import type { UiControlPlaneSnapshot, UiLocalAuthSnapshot, UiSessionSnapshot, UiTasksSnapshot } from '../ui-read-models.js';
import type { UiRuntimeEvents } from '../ui-events.js';
import type { TransportPaths } from './transport-paths.js';
import type { HttpRetryPolicy } from './http-json-transport.js';

/** Options of the daemon client (createDaemonHttpTransport). */
export interface DaemonHttpTransportOptions {
  readonly baseUrl: string;
  readonly authToken?: string | null | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  /** Retry policy of the JSON transport. Absent means one attempt per request. */
  readonly retry?: HttpRetryPolicy | undefined;
  /** Retry observers of the JSON transport; see `transportRetryHooks` to bind them to the runtime bus. */
  readonly onRetryScheduled?: ((info: { attempt: number; maxAttempts: number; backoffMs: number; reason: string }) => void) | undefined;
  readonly onRetryExecuted?: ((info: { attempt: number; maxAttempts: number }) => void) | undefined;
}

export interface HttpProvidersSnapshot {
  readonly providerIds: readonly string[];
  readonly runtimeSnapshots: readonly ProviderRuntimeSnapshot[];
  readonly accountSnapshot: Record<string, unknown>;
  readonly localAuthSnapshot: UiLocalAuthSnapshot;
}

export interface HttpTransportOperatorSnapshot {
  readonly currentSession: UiSessionSnapshot;
  readonly tasks: UiTasksSnapshot;
  readonly approvals: readonly SharedApprovalRecord[];
  readonly sessions: readonly SharedSessionRecord[];
  readonly controlPlane: UiControlPlaneSnapshot;
  readonly providers: HttpProvidersSnapshot;
  readonly shellPaths: TransportPaths;
}

export interface HttpPeerSnapshot {
  readonly capturedAt: number;
  readonly nodeHostContract: DistributedNodeHostContract;
  readonly remoteSnapshot: Record<string, unknown>;
  readonly pairRequests: readonly DistributedRuntimePairRequest[];
  readonly peers: readonly DistributedPeerRecord[];
  readonly work: readonly DistributedPendingWork[];
}

export interface HttpTransportSnapshot {
  readonly kind: 'http';
  readonly operator: HttpTransportOperatorSnapshot;
  readonly peer: HttpPeerSnapshot;
}

export interface HttpTransportSessionsClient {
  current(): Promise<UiSessionSnapshot>;
  list(limit?: number): Promise<readonly SharedSessionRecord[]>;
  get(sessionId: string): Promise<SharedSessionRecord | null>;
  messages(sessionId: string, limit?: number): Promise<readonly SharedSessionMessage[]>;
  inputs(sessionId: string, limit?: number, options?: { readonly state?: string | undefined; readonly since?: number | undefined }): Promise<readonly SharedSessionInputRecord[]>;
  /** A live surface's collection read: the oldest inputs after `since`, and whether more remain (ask again from `next`). */
  inputsPage(sessionId: string, options: { readonly state?: string | undefined; readonly since?: number | undefined; readonly limit?: number | undefined }): Promise<Page<SharedSessionInputRecord>>;
  ensureSession(input?: HttpSessionEnsureInput): Promise<SharedSessionRecord>;
  register(input: RegisterSharedSessionInput): Promise<SharedSessionRegisterResult>;
  close(sessionId: string): Promise<SharedSessionRecord | null>;
  reopen(sessionId: string): Promise<SharedSessionRecord | null>;
  submitMessage(sessionId: string, input: HttpSessionMessageInput): Promise<SharedSessionSubmissionReceipt>;
  steerMessage(sessionId: string, input: HttpSteerSessionMessageInput): Promise<SharedSessionSubmissionReceipt>;
  followUpMessage(sessionId: string, input: HttpSessionMessageInput): Promise<SharedSessionSubmissionReceipt>;
  cancelInput(sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null>;
  deliverInput(
    sessionId: string,
    inputId: string,
    options?: {
      readonly consumed?: boolean | undefined;
      /** Take the input before working on it; refused (409) when another surface already holds it. */
      readonly claim?: boolean | undefined;
      /** The agent this surface is running for the input, binds the channel reply. */
      readonly agentId?: string | undefined;
      /** The surface process running that agent, so a restarted surface can fail what a process that is gone was answering. */
      readonly surfaceInstance?: string | undefined;
      /** That agent's finished output, reported with `consumed:true`. */
      readonly answer?: string | undefined;
      readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
      /** The surface's claim token (`metadata.claimEpoch` of its granted claim): renews the claim with `claim`, and must be current on every other report. */
      readonly claimEpoch?: number | undefined;
    },
  ): Promise<SharedSessionInputRecord | null>;
}

export interface HttpTransportTasksClient {
  snapshot(): Promise<UiTasksSnapshot>;
  list(limit?: number): Promise<readonly import('../store/domains/tasks.js').RuntimeTask[]>;
  get(taskId: string): Promise<import('../store/domains/tasks.js').RuntimeTask | null>;
  running(): Promise<readonly import('../store/domains/tasks.js').RuntimeTask[]>;
  submit(input: HttpTaskSubmitInput): Promise<HttpTaskSubmitResponse>;
  cancel(taskId: string): Promise<HttpTaskActionResponse>;
  retry(taskId: string): Promise<HttpTaskRetryResponse>;
}

/**
 * What an approval action sends. `expectedRevision` is the `revision` of the
 * approval the caller showed or read; the daemon refuses a stale one with
 * APPROVAL_CHANGED. Who acted is taken from the credential, never the body.
 */
export interface HttpApprovalActionInput {
  readonly expectedRevision: number;
  readonly note?: string | undefined;
  readonly remember?: boolean | undefined;
}

export interface HttpApprovalApproveInput extends HttpApprovalActionInput {
  /** Edit-tool approvals only: the hunk indices to apply; absent approves the whole request. */
  readonly selectedHunks?: readonly number[] | undefined;
  readonly rememberTier?: RememberTier | undefined;
  readonly reason?: string | undefined;
  /** An argument-modifying approval (e.g. the typed answer to a command's prompt); `selectedHunks` supersedes it. */
  readonly modifiedArgs?: Record<string, unknown> | undefined;
}

export interface HttpApprovalDenyInput extends HttpApprovalActionInput {
  /** `amended` asks for a change instead of refusing outright; it cannot be remembered. Default `denied`. */
  readonly disposition?: 'denied' | 'amended' | undefined;
  readonly rememberTier?: RememberTier | undefined;
  readonly reason?: string | undefined;
}

/**
 * A cancel names the revision it read; a surface that raised the ask gives up
 * its own hold instead with `release: true` and the `holdId` approvals.raise
 * returned, and needs no revision.
 */
export type HttpApprovalCancelInput =
  | (HttpApprovalActionInput & { readonly release?: false | undefined })
  | {
    readonly release: true;
    readonly holdId?: string | undefined;
    readonly expectedRevision?: number | undefined;
    readonly note?: string | undefined;
  };

/**
 * The daemon's answer to an approval action. `applied` false means nothing
 * changed as asked, and `refusal.code` says why (APPROVAL_SETTLED,
 * APPROVAL_CHANGED, APPROVAL_EXPIRED, OWNER_DECISION_REQUIRED); the record and
 * the caller's reading are as they are now, so a stale action can be shown
 * again and retried at the current revision.
 */
export interface HttpApprovalActionOutcome {
  readonly applied: boolean;
  readonly approval?: SharedApprovalRecord | undefined;
  readonly reading?: ApprovalReading | undefined;
  readonly refusal?: Refusal | undefined;
  /** Approve and deny: what the daemon recorded on the decision. */
  readonly recorded?: {
    readonly approved: boolean;
    readonly rememberTier: RememberTier | null;
    readonly reasonStored: boolean;
    readonly modifiedArgsDelivered: boolean;
  } | undefined;
}

export interface HttpTransportApprovalsClient {
  /** The daemon's newest approvals; it takes no page size. */
  list(): Promise<readonly SharedApprovalRecord[]>;
  get(approvalId: string): Promise<SharedApprovalRecord | null>;
  /** Each action resolves to the daemon's outcome, or null for an approval the daemon does not know (404). */
  claim(approvalId: string, input: HttpApprovalActionInput): Promise<HttpApprovalActionOutcome | null>;
  approve(approvalId: string, input: HttpApprovalApproveInput): Promise<HttpApprovalActionOutcome | null>;
  deny(approvalId: string, input: HttpApprovalDenyInput): Promise<HttpApprovalActionOutcome | null>;
  cancel(approvalId: string, input: HttpApprovalCancelInput): Promise<HttpApprovalActionOutcome | null>;
}

export interface HttpTransportProvidersClient {
  listIds(): Promise<readonly string[]>;
  runtimeSnapshots(): Promise<readonly ProviderRuntimeSnapshot[]>;
  runtimeSnapshot(providerId: string): Promise<ProviderRuntimeSnapshot | null>;
  usageSnapshot(providerId: string): Promise<ProviderUsageSnapshot | null>;
  accountSnapshot(): Promise<Record<string, unknown>>;
  localAuthSnapshot(): Promise<UiLocalAuthSnapshot>;
  snapshot(): Promise<HttpProvidersSnapshot>;
}

export interface HttpTransportControlPlaneClient {
  snapshot(): Promise<UiControlPlaneSnapshot>;
  recentEvents(limit?: number): Promise<readonly ControlPlaneRecentEvent[]>;
  currentAuth(): Promise<HttpTransportControlPlaneAuthSnapshot>;
}

export interface HttpTransportControlPlaneAuthSnapshot extends ControlPlaneAuthSnapshot {}

export interface HttpTransportTelemetryMetricsSnapshot {
  readonly version: 1;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly generatedAt: number;
  readonly runtime: TelemetryRuntimeSnapshot;
  readonly sessionMetrics: TelemetrySnapshot['sessionMetrics'];
  readonly aggregates: TelemetryAggregates;
}

export type HttpTransportTelemetryQuery = TelemetryFilter | number;

export interface HttpTransportTelemetryStreamReady {
  readonly version: 1;
  readonly capabilities: TelemetryCapabilities;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly resumedFrom?: string | undefined;
  /** The resume cursor was no longer held: records between it and the first one sent may be missing. */
  readonly gap?: boolean | undefined;
  /** More records were missed than one resume sends; the oldest of them were skipped. */
  readonly truncated?: boolean | undefined;
}

export interface HttpTransportTelemetryStreamHandlers {
  readonly onRecord: (record: TelemetryRecord) => void;
  readonly onReady?: ((payload: HttpTransportTelemetryStreamReady) => void) | undefined;
  /** The stream reconnects after a drop: the attempt, the wait before it, and the failure that lost it. */
  readonly onReconnect?: ((input: { readonly attempt: number; readonly delayMs: number; readonly error: unknown }) => void) | undefined;
  /** Records were dropped for this reader: read a snapshot again; never ignore it. */
  readonly onGap: (gap: StreamGap) => void;
  /** The stream ended (closed by the caller, ended by the daemon, or failed for good): no more records will arrive. */
  readonly onEnd: (end: StreamEnd) => void;
}

export interface HttpTransportTelemetryClient {
  snapshot(query?: HttpTransportTelemetryQuery): Promise<TelemetrySnapshot>;
  events(query?: HttpTransportTelemetryQuery): Promise<TelemetryListResponse<TelemetryRecord>>;
  errors(query?: HttpTransportTelemetryQuery): Promise<TelemetryListResponse<TelemetryRecord>>;
  traces(query?: HttpTransportTelemetryQuery): Promise<TelemetryListResponse<import('../telemetry/types.js').ReadableSpan>>;
  metrics(query?: HttpTransportTelemetryQuery): Promise<HttpTransportTelemetryMetricsSnapshot>;
  otlpTraces(query?: HttpTransportTelemetryQuery): Promise<Record<string, unknown>>;
  otlpLogs(query?: HttpTransportTelemetryQuery): Promise<Record<string, unknown>>;
  otlpMetrics(query?: HttpTransportTelemetryQuery): Promise<Record<string, unknown>>;
  stream(handlers: HttpTransportTelemetryStreamHandlers, query?: HttpTransportTelemetryQuery): Promise<() => void>;
}

export interface HttpTransportOperatorClient {
  readonly sessions: HttpTransportSessionsClient;
  readonly tasks: HttpTransportTasksClient;
  readonly approvals: HttpTransportApprovalsClient;
  readonly providers: HttpTransportProvidersClient;
  readonly controlPlane: HttpTransportControlPlaneClient;
  readonly telemetry: HttpTransportTelemetryClient;
  readonly events: UiRuntimeEvents;
  readonly shellPaths: TransportPaths;
}

export interface HttpTransportPeerPairingClient {
  listRequests(limit?: number): Promise<readonly DistributedRuntimePairRequest[]>;
  request(input: HttpRemotePairRequestInput): Promise<HttpRemotePairResponse>;
  /** `confirmReplace` is required when the request names an existing peer; without it the daemon refuses with REMOTE_PAIR_REPLACES_PEER. */
  approve(requestId: string, actor: string, note?: string, confirmReplace?: boolean): Promise<HttpRemotePairApprovalResponse | null>;
  reject(requestId: string, actor: string, note?: string): Promise<DistributedRuntimePairRequest | null>;
  verify(requestId: string, challenge: string, remoteAddress?: string): Promise<HttpRemotePairVerificationResponse | null>;
}

export interface HttpTransportPeerPeersClient {
  list(kind?: DistributedPeerKind, limit?: number): Promise<readonly DistributedPeerRecord[]>;
  get(peerId: string): Promise<DistributedPeerRecord | null>;
  getSnapshot(peerId: string): Promise<HttpPeerRecordSnapshot | null>;
  heartbeat(tokenValue: string, input?: HttpRemotePeerHeartbeatInput): Promise<{ peer: DistributedPeerRecord }>;
  rotateToken(peerId: string, actor: string, label?: string, scopes?: readonly string[]): Promise<HttpRemotePeerTokenResponse | null>;
  revokeToken(peerId: string, actor: string, tokenId?: string, note?: string): Promise<DistributedPeerRecord | null>;
  disconnect(peerId: string, actor: string, note?: string, requeueClaimedWork?: boolean): Promise<DistributedPeerRecord | null>;
}

export interface HttpTransportPeerWorkClient {
  list(limit?: number, peerId?: string): Promise<readonly DistributedPendingWork[]>;
  invoke(input: HttpRemotePeerInvokeInput): Promise<HttpRemotePeerInvokeResponse>;
  claim(tokenValue: string, input?: HttpRemotePeerClaimInput): Promise<readonly DistributedPendingWork[]>;
  complete(tokenValue: string, workId: string, input?: HttpRemotePeerCompleteInput): Promise<DistributedPendingWork | null>;
  cancel(workId: string, actor: string, note?: string): Promise<DistributedPendingWork | null>;
}

export interface HttpTransportPeerClient {
  readonly pairing: HttpTransportPeerPairingClient;
  readonly peers: HttpTransportPeerPeersClient;
  readonly work: HttpTransportPeerWorkClient;
  getSnapshot(): Promise<HttpPeerSnapshot>;
  getNodeHostContract(): Promise<DistributedNodeHostContract>;
}

export interface HttpTransport {
  readonly kind: 'http';
  readonly operator: HttpTransportOperatorClient;
  readonly peer: HttpTransportPeerClient;
  getOperatorClient(): HttpTransportOperatorClient;
  getPeerClient(): HttpTransportPeerClient;
  snapshot(): Promise<HttpTransportSnapshot>;
}

export interface HttpSessionEnsureInput {
  readonly sessionId?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly routeId?: string | undefined;
  readonly participant?: {
    readonly surfaceKind: string;
    readonly surfaceId: string;
    readonly externalId?: string | undefined;
    readonly userId?: string | undefined;
    readonly displayName?: string | undefined;
  };
}

export interface HttpSessionMessageInput {
  readonly body: string;
  readonly surfaceKind?: string | undefined;
  readonly surfaceId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly title?: string | undefined;
  readonly routeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly routing?: SteerSharedSessionMessageInput['routing'] | undefined;
}

export interface HttpSteerSessionMessageInput extends HttpSessionMessageInput {
  readonly allowSpawnFallback?: boolean | undefined;
}

export interface HttpTaskSubmitInput {
  readonly task: string;
  readonly model?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly routing?: HttpSessionMessageInput['routing'] | undefined;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly surfaceKind?: string | undefined;
  readonly surfaceId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HttpTaskSubmitResponse {
  readonly acknowledged: boolean;
  readonly mode?: string | undefined;
  readonly sessionId?: string | null | undefined;
  readonly agentId?: string | null | undefined;
  readonly status?: string | undefined;
  readonly task?: string | undefined;
}

export interface HttpTaskActionResponse {
  readonly task: import('../store/domains/tasks.js').RuntimeTask | null;
}

export interface HttpTaskRetryResponse {
  readonly retried?: boolean | undefined;
  readonly task: import('../store/domains/tasks.js').RuntimeTask | null;
  readonly agentId?: string | undefined;
}

export interface HttpRemotePairRequestInput {
  readonly peerKind: DistributedPeerKind;
  readonly label: string;
  readonly requestedId?: string | undefined;
  readonly platform?: string | undefined;
  readonly deviceFamily?: string | undefined;
  readonly version?: string | undefined;
  readonly clientMode?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
  readonly commands?: readonly string[] | undefined;
  readonly ttlMs?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HttpRemotePairResponse {
  readonly request: DistributedRuntimePairRequest;
  readonly challenge: string;
}

export interface HttpRemotePairApprovalResponse {
  readonly request: DistributedRuntimePairRequest;
  readonly peer: DistributedPeerRecord;
}

export interface HttpRemotePairVerificationResponse {
  readonly peer: DistributedPeerRecord;
  readonly token: DistributedPeerTokenRecord & { readonly value: string };
}

export interface HttpRemotePeerHeartbeatInput {
  readonly capabilities?: readonly string[] | undefined;
  readonly commands?: readonly string[] | undefined;
  readonly version?: string | undefined;
  readonly clientMode?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HttpRemotePeerTokenResponse {
  readonly peer: DistributedPeerRecord;
  readonly token: DistributedPeerTokenRecord & { readonly value: string };
}

export interface HttpRemotePeerInvokeInput {
  readonly peerId: string;
  readonly command: string;
  readonly payload?: unknown | undefined;
  readonly priority?: DistributedWorkPriority | undefined;
  readonly waitMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly automationRunId?: string | undefined;
  readonly automationJobId?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * A paired peer answers with the work queued for it; a registered backend
 * (docker, ssh, cloud terminal, local process) with the finished run.
 */
export type HttpRemotePeerInvokeResponse =
  | { readonly work: DistributedPendingWork; readonly completed: boolean; readonly backend?: undefined }
  | { readonly backend: RemoteBackendInvokeResult; readonly completed: true; readonly work?: undefined };

export interface HttpRemotePeerClaimInput {
  readonly maxItems?: number | undefined;
  readonly leaseMs?: number | undefined;
}

export interface HttpRemotePeerCompleteInput {
  readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
  readonly result?: unknown | undefined;
  readonly error?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HttpPeerRecordSnapshot {
  readonly peerId: string;
  readonly peer: DistributedPeerRecord | null;
  readonly pairRequests: readonly DistributedRuntimePairRequest[];
  readonly work: readonly DistributedPendingWork[];
  readonly nodeHostContract: DistributedNodeHostContract;
}

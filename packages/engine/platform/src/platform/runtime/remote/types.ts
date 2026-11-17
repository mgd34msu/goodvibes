/**
 * Remote runners, Core Types
 *
 * Runner contracts and pools, the evidence a runner's work leaves, and the
 * portable bundle `/remote export` writes and `/remote import` reads.
 */

import type { DaemonTransportState } from '../store/domains/daemon.js';

// ── Transport State ───────────────────────────────────────────────────────────

/** Re-export the shared transport lifecycle state. */
export type { DaemonTransportState as RemoteTransportState };

// Remote runner contracts and portable review artifacts.

export interface RemoteRunnerCapabilityCeiling {
  readonly allowedTools: readonly string[];
  readonly capabilityCeilingTools: readonly string[];
  readonly executionProtocol: 'direct' | 'gather-plan-apply';
  readonly reviewMode: 'none' | 'contract';
  readonly communicationLane: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct';
  readonly orchestrationDepth: number;
  readonly successCriteria: readonly string[];
  readonly requiredEvidence: readonly string[];
  readonly writeScope: readonly string[];
}

export interface RemoteRunnerContract {
  readonly id: string;
  readonly runnerId: string;
  readonly poolId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly label: string;
  readonly sourceTransport: 'acp' | 'daemon';
  readonly trustClass: 'self-hosted-acp' | 'local-daemon';
  readonly template: string;
  readonly parentAgentId?: string | undefined;
  readonly orchestrationGraphId?: string | undefined;
  readonly orchestrationNodeId?: string | undefined;
  readonly capabilityCeiling: RemoteRunnerCapabilityCeiling;
  /**
   * The runtime's working directory, set by the registry that built the
   * contract: the workspace the runner's write scope is read against. Absent
   * when the contract was built or imported without one.
   */
  readonly workspaceRoot?: string | undefined;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
  /**
   * The runner's connection. Absent for a runner that has none: a local
   * sub-agent or orchestration node runs in this process, so it has no
   * transport, heartbeat or reconnect to report.
   */
  readonly transport?: {
    readonly state: DaemonTransportState;
    readonly connectedAt?: number | undefined;
    readonly messageCount: number;
    readonly errorCount: number;
    readonly lastError?: string | undefined;
  };
}

export interface RemoteRunnerPool {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly trustClass: RemoteRunnerContract['trustClass'] | 'mixed';
  readonly preferredTemplate?: string | undefined;
  readonly maxRunners?: number | undefined;
  readonly runnerIds: readonly string[];
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

export interface RemoteRunnerEvidenceSummary {
  readonly toolCallCount: number;
  readonly messageCount: number;
  readonly errorCount: number;
  /** Absent for a runner with no transport (see RemoteRunnerContract.transport). */
  readonly transportState?: DaemonTransportState | undefined;
  readonly connectedAt?: number | undefined;
  readonly lastError?: string | undefined;
  readonly hasKnowledgeInjections: boolean;
}

export interface RemoteExecutionArtifact {
  readonly id: string;
  readonly runnerId: string;
  readonly createdAt: number;
  readonly runnerContract: RemoteRunnerContract;
  readonly task: {
    readonly task: string;
    readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    readonly startedAt: number;
    readonly completedAt?: number | undefined;
    readonly summary: string;
    readonly fullOutput?: string | undefined;
    readonly error?: string | undefined;
    readonly progress?: string | undefined;
  };
  readonly evidence: RemoteRunnerEvidenceSummary;
  readonly knowledgeInjections: readonly {
    readonly id: string;
    readonly cls: string;
    readonly summary: string;
    readonly reason: string;
    readonly confidence: number;
    readonly reviewState: 'fresh' | 'reviewed' | 'stale' | 'contradicted';
  }[];
}

export interface RemoteSessionBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly sessionId: string;
  readonly activeConnectionIds: readonly string[];
  readonly pools: readonly RemoteRunnerPool[];
  readonly contracts: readonly RemoteRunnerContract[];
  readonly artifacts: readonly RemoteExecutionArtifact[];
}

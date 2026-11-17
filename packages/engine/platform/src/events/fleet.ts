/**
 * FleetEvent, discriminated union of live process-registry lifecycle events.
 *
 * These are the wire-surfaced, poll-free counterpart to the ProcessRegistry's
 * in-process coalesced snapshot tick: an emit-bridge diffs consecutive registry
 * snapshots and emits these per-node lifecycle deltas onto the runtime event bus
 * `fleet` domain, which the control-plane gateway already fans out to subscribed
 * SSE/WebSocket clients (no new channel). Every field here is DERIVED from the
 * authoritative snapshot, the events carry no state the snapshot does not, in
 * keeping with the registry's contract ("a view, not a second source of truth").
 *
 * This leaf module owns the fleet vocabulary: the node kinds, states and
 * attention reasons are the runtime arrays below, and every other description
 * of them (the process registry's types, the operator contract schema, the
 * fleet.list filter, the clients) reads these arrays or the types derived from
 * them. It imports nothing from `platform/`.
 */

/** Every kind of node the fleet shows. */
export const FLEET_NODE_KINDS = [
  'agent',
  // The contract tree (docs/design/contract-runner.md section 8.3): a
  // contract (root) -> its groups -> their units, a best-of-N unit's attempts
  // under the unit, and each unit's agents under the unit.
  'contract',
  'contract-group',
  'contract-unit',
  'workflow',
  // The trigger family (platform/triggers: watchers, condition checks, on-exit
  // process triggers), persisted and supervised.
  'trigger',
  // The workflow tool's hook actions: run a command when a hook event fires.
  'hook-action',
  'schedule',
  'watcher',
  'background-process',
  // A HOSTED third-party coding agent (Claude Code / Codex CLI / opencode)
  // running as a long-lived daemon session over the Agent Client Protocol,
  // see platform/acp/host.ts and adapters/acp-host.ts.
  'acp-agent',
  // An externally-launched coding-agent session goodvibes did NOT spawn or host
  // (someone's own Claude Code / Codex process on this host), found by read-only
  // process-table detection. It is OBSERVED, not owned: it never counts against
  // fleet.maxSize (fleet-count.ts accepts only owned sources by construction),
  // stop is never offered, and steering rides whatever control channel the
  // foreign session genuinely exposes (a tmux pane) or honestly says there is
  // none. See adapters/observed.ts and observed/*.
  'observed-external',
  // The repo source-tree code index's initial build (Stage A). Not
  // 'background-process': an index build has no pid (ProcessManager
  // is shell/OS-process-only), so it gets its own kind, mirroring the
  // other optional deps (degrades to today when absent).
  'code-index',
] as const;

/** Every coarse state a fleet node can be in. */
export const FLEET_NODE_STATES = [
  'thinking',
  'executing-tool',
  'awaiting-approval',
  'streaming',
  'stalled',
  'retrying',
  'done',
  'failed',
  'killed',
  'interrupted',
  'idle',
  'queued',
  'paused',
] as const;

/** Every way a node can wait on a human; each is first-class. */
export const FLEET_ATTENTION_REASONS = ['approval', 'input', 'pick', 'conflict'] as const;

export type FleetNodeKind = (typeof FLEET_NODE_KINDS)[number];

export type FleetNodeState = (typeof FLEET_NODE_STATES)[number];

export type FleetAttentionReason = (typeof FLEET_ATTENTION_REASONS)[number];

export type FleetEvent =
  /** A node appeared in the fleet for the first time. */
  | {
      type: 'FLEET_NODE_STARTED';
      nodeId: string;
      kind: FleetNodeKind;
      label: string;
      state: FleetNodeState;
      parentId?: string | undefined;
      sessionId?: string | undefined;
    }
  /** A node's coarse state changed (non-terminal, non-block transition). */
  | {
      type: 'FLEET_NODE_STATE_CHANGED';
      nodeId: string;
      kind: FleetNodeKind;
      state: FleetNodeState;
      previousState: FleetNodeState;
      label: string;
      sessionId?: string | undefined;
    }
  /** A node reached a terminal state (done/failed/killed/interrupted). */
  | {
      type: 'FLEET_NODE_FINISHED';
      nodeId: string;
      kind: FleetNodeKind;
      state: FleetNodeState;
      previousState: FleetNodeState;
      label: string;
      sessionId?: string | undefined;
    }
  /** A node became blocked waiting for a human (approve/deny, input, a ready best-of-N pick, or a merge conflict). */
  | {
      type: 'FLEET_NODE_BLOCKED_ON_USER';
      nodeId: string;
      kind: FleetNodeKind;
      reason: FleetAttentionReason;
      label: string;
      detail?: string | undefined;
      sessionId?: string | undefined;
      agentId?: string | undefined;
    }
  /** A previously blocked node is no longer waiting on a human. */
  | {
      type: 'FLEET_NODE_UNBLOCKED';
      nodeId: string;
      kind: FleetNodeKind;
      state: FleetNodeState;
      label: string;
      sessionId?: string | undefined;
    };

export type FleetEventType = FleetEvent['type'];

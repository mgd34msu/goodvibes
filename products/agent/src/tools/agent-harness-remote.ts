import type { CommandContext } from '../input/command-registry.ts';

export interface AgentHarnessRemoteArgs {
  readonly target?: unknown;
  readonly query?: unknown;
  readonly peerId?: unknown;
  readonly requestId?: unknown;
  readonly workId?: unknown;
  readonly command?: unknown;
  readonly payload?: unknown;
  readonly note?: unknown;
  readonly confirmReplace?: unknown;
  readonly reason?: unknown;
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
}

type RemoteReadSurface =
  | 'remote_snapshot'
  | 'remote_peers'
  | 'remote_work'
  | 'remote_pair_requests';

type RemoteMutationSurface =
  | 'remote_pair_approve'
  | 'remote_pair_reject'
  | 'remote_peers_invoke'
  | 'remote_work_cancel';

type RemoteSurface = RemoteReadSurface | RemoteMutationSurface;

interface RemoteMethodHandoff {
  readonly surface: RemoteSurface;
  readonly methodId: string;
  readonly route: string;
  readonly effect: 'connected-host-state';
  readonly recordedAdmissionRequired: true;
  readonly input: Record<string, unknown>;
  readonly modelRoute: string;
  readonly policy: string;
}

export interface RemoteMissingInput {
  readonly surface: RemoteMutationSurface;
  readonly status: 'missing_input';
  readonly missing: readonly string[];
  readonly error: string;
  readonly next: string;
}

const REMOTE_REQUIRED_INPUT: Readonly<Record<RemoteMutationSurface, { readonly fields: readonly string[]; readonly next: string }>> = {
  remote_pair_approve: { fields: ['requestId'], next: 'Call mode:"remote_pair_requests" to list pending requests, then pass requestId (or target) of the request to approve.' },
  remote_pair_reject: { fields: ['requestId'], next: 'Call mode:"remote_pair_requests" to list pending requests, then pass requestId (or target) of the request to reject.' },
  remote_peers_invoke: { fields: ['peerId', 'command'], next: 'Call mode:"remote_peers" to list peers, then pass peerId (or target) and the command to run.' },
  remote_work_cancel: { fields: ['workId'], next: 'Call mode:"remote_work" to list queued and leased work, then pass workId (or target) of the item to cancel.' },
};

/** Names the required ids a mutation surface is missing, so the dispatcher can refuse before recorded admission is spent. */
export function remoteMissingInput(surface: RemoteMutationSurface, args: AgentHarnessRemoteArgs): RemoteMissingInput | null {
  const required = REMOTE_REQUIRED_INPUT[surface];
  const present: Record<string, string> = {
    requestId: readString(args.requestId || args.target),
    peerId: readString(args.peerId || args.target),
    workId: readString(args.workId || args.target),
    command: readString(args.command),
  };
  const missing = required.fields.filter((field) => !present[field]);
  if (missing.length === 0) return null;
  return {
    surface,
    status: 'missing_input',
    missing,
    error: `${surface} requires ${missing.join(' and ')}; no handoff was produced.`,
    next: required.next,
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// ---------------------------------------------------------------------------
// Catalog status (for summary mode inclusion)
// ---------------------------------------------------------------------------

export function remoteCatalogStatus(_context: CommandContext): Record<string, unknown> {
  return {
    modes: [
      'remote_snapshot',
      'remote_peers',
      'remote_work',
      'remote_pair_requests',
      'remote_pair_approve',
      'remote_pair_reject',
      'remote_peers_invoke',
      'remote_work_cancel',
    ],
    readModes: 4,
    mutationModes: 4,
    policy:
      'Distributed remote execution surface. Read modes call remote.snapshot, remote.peers.list, remote.work.list, and remote.pair.requests.list via agent_operator_method. Mutation modes (approve/reject pair requests, invoke peer command, cancel work) require current recorded Jev act admission and return an agent_operator_method handoff. Executing that handoff requires fresh admission on the operator route. Native pairing retains its independent protocol.',
  };
}

// ---------------------------------------------------------------------------
// Read surfaces, return route descriptors; agent_operator_method executes them
// ---------------------------------------------------------------------------

export function remoteSnapshotSummary(_args: AgentHarnessRemoteArgs): Record<string, unknown> {
  return {
    surface: 'remote_snapshot',
    methodId: 'remote.snapshot',
    route: 'GET /api/remote',
    effect: 'read-only-network',
    recordedAdmissionRequired: false,
    modelRoute: 'agent_operator_method methodId:"remote.snapshot" input:{}',
    description:
      'Returns a distributed remote execution snapshot: connected peers, queued/leased work, and pair request counts.',
    policy:
      'Read-only. Call agent_operator_method methodId:"remote.snapshot" input:{} to fetch the live snapshot from the daemon.',
  };
}

export function remotePeersSummary(_args: AgentHarnessRemoteArgs): Record<string, unknown> {
  return {
    surface: 'remote_peers',
    methodId: 'remote.peers.list',
    route: 'GET /api/remote/peers',
    effect: 'read-only-network',
    recordedAdmissionRequired: false,
    modelRoute: 'agent_operator_method methodId:"remote.peers.list" input:{}',
    description: 'Lists connected and recently-disconnected remote peers.',
    policy:
      'Read-only. Call agent_operator_method methodId:"remote.peers.list" input:{} to fetch the live peer list.',
  };
}

export function remoteWorkSummary(_args: AgentHarnessRemoteArgs): Record<string, unknown> {
  return {
    surface: 'remote_work',
    methodId: 'remote.work.list',
    route: 'GET /api/remote/work',
    effect: 'read-only-network',
    recordedAdmissionRequired: false,
    modelRoute: 'agent_operator_method methodId:"remote.work.list" input:{}',
    description: 'Lists queued and leased remote work items.',
    policy:
      'Read-only. Call agent_operator_method methodId:"remote.work.list" input:{} to fetch queued and leased work.',
  };
}

export function remotePairRequestsSummary(_args: AgentHarnessRemoteArgs): Record<string, unknown> {
  return {
    surface: 'remote_pair_requests',
    methodId: 'remote.pair.requests.list',
    route: 'GET /api/remote/pair/requests',
    effect: 'read-only-network',
    recordedAdmissionRequired: false,
    modelRoute: 'agent_operator_method methodId:"remote.pair.requests.list" input:{}',
    description: 'Lists pending, approved, and rejected remote pairing requests.',
    policy:
      'Read-only. Call agent_operator_method methodId:"remote.pair.requests.list" input:{} to fetch the current pair request queue.',
  };
}

// ---------------------------------------------------------------------------
// Mutation surfaces return handoffs after the dispatcher checks recorded admission
// ---------------------------------------------------------------------------

export function remotePairApproveHandoff(args: AgentHarnessRemoteArgs): RemoteMethodHandoff | RemoteMissingInput {
  const missing = remoteMissingInput('remote_pair_approve', args);
  if (missing) return missing;
  const requestId = readString(args.requestId || args.target);
  const note = readString(args.note);
  const input: Record<string, unknown> = { requestId };
  if (note) input.note = note;
  // Only an explicit true replaces an existing peer; a stringified "true" from a model is not consent.
  if (args.confirmReplace === true) input.confirmReplace = true;
  return {
    surface: 'remote_pair_approve',
    methodId: 'remote.pair.requests.approve',
    route: 'POST /api/remote/pair/requests/{requestId}/approve',
    effect: 'connected-host-state',
    recordedAdmissionRequired: true,
    input,
    modelRoute:
      `agent_operator_method methodId:"remote.pair.requests.approve" input:${JSON.stringify(input)}`,
    policy:
      'Approves a pending remote pair request by requestId. If the request names an existing peer the daemon refuses with REMOTE_PAIR_REPLACES_PEER; pass confirmReplace:true only when it is the same device re-pairing. This handoff requires current recorded Jev act admission; the agent_operator_method call requires fresh admission. The native pairing protocol remains required.',
  };
}

export function remotePairRejectHandoff(args: AgentHarnessRemoteArgs): RemoteMethodHandoff | RemoteMissingInput {
  const missing = remoteMissingInput('remote_pair_reject', args);
  if (missing) return missing;
  const requestId = readString(args.requestId || args.target);
  const note = readString(args.note);
  const input: Record<string, unknown> = { requestId };
  if (note) input.note = note;
  return {
    surface: 'remote_pair_reject',
    methodId: 'remote.pair.requests.reject',
    route: 'POST /api/remote/pair/requests/{requestId}/reject',
    effect: 'connected-host-state',
    recordedAdmissionRequired: true,
    input,
    modelRoute:
      `agent_operator_method methodId:"remote.pair.requests.reject" input:${JSON.stringify(input)}`,
    policy:
      'Rejects a pending remote pair request by requestId. This handoff requires current recorded Jev act admission; the agent_operator_method call requires fresh admission. The native pairing protocol remains required.',
  };
}

export function remotePeersInvokeHandoff(args: AgentHarnessRemoteArgs): RemoteMethodHandoff | RemoteMissingInput {
  const missing = remoteMissingInput('remote_peers_invoke', args);
  if (missing) return missing;
  const peerId = readString(args.peerId || args.target);
  const command = readString(args.command);
  const payload = readRecord(args.payload);
  const input: Record<string, unknown> = { peerId, command };
  if (Object.keys(payload).length > 0) input.payload = payload;
  return {
    surface: 'remote_peers_invoke',
    methodId: 'remote.peers.invoke',
    route: 'POST /api/remote/peers/{peerId}/invoke',
    effect: 'connected-host-state',
    recordedAdmissionRequired: true,
    input,
    modelRoute:
      `agent_operator_method methodId:"remote.peers.invoke" input:${JSON.stringify(input)}`,
    policy:
      'Invokes a command on a connected remote peer. Requires peerId and command, current recorded Jev act admission for this handoff, and fresh admission on the agent_operator_method call. The peer must satisfy the native pairing protocol.',
  };
}

export function remoteWorkCancelHandoff(args: AgentHarnessRemoteArgs): RemoteMethodHandoff | RemoteMissingInput {
  const missing = remoteMissingInput('remote_work_cancel', args);
  if (missing) return missing;
  const workId = readString(args.workId || args.target);
  const reason = readString(args.reason);
  const input: Record<string, unknown> = { workId };
  if (reason) input.reason = reason;
  return {
    surface: 'remote_work_cancel',
    methodId: 'remote.work.cancel',
    route: 'POST /api/remote/work/{workId}/cancel',
    effect: 'connected-host-state',
    recordedAdmissionRequired: true,
    input,
    modelRoute:
      `agent_operator_method methodId:"remote.work.cancel" input:${JSON.stringify(input)}`,
    policy:
      'Cancels a queued or leased remote work item by workId. This handoff requires current recorded Jev act admission; the agent_operator_method call requires fresh admission and its native owner checks.',
  };
}

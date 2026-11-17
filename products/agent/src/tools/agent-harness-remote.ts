import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { error, readString, requireConfirmedAction } from './agent-harness-tool-utils.ts';

export interface AgentHarnessRemoteArgs {
  readonly target?: unknown;
  readonly peerId?: unknown;
  readonly requestId?: unknown;
  readonly workId?: unknown;
  readonly command?: unknown;
  readonly payload?: unknown;
  readonly note?: unknown;
  readonly confirmReplace?: unknown;
  readonly reason?: unknown;
  readonly displayName?: unknown;
  readonly backendKind?: unknown;
  readonly backendConfig?: unknown;
}

type RemoteResult = { readonly success: boolean; readonly output?: string; readonly error?: string };

interface RemoteModeRoute {
  /** The connected host's operator method this mode runs. */
  readonly methodId: string;
  /** Present on a mode that changes host state: what the owner admits, in words. */
  readonly action?: string;
  /** Builds the method input, or names what is missing and where to find it. */
  readonly input?: (args: AgentHarnessRemoteArgs) => RemoteInput;
}

type RemoteInput = { readonly input: Record<string, unknown> } | { readonly missing: readonly string[]; readonly next: string };

function missing(fields: readonly string[], next: string): RemoteInput {
  return { missing: fields, next };
}

const REMOTE_MODE_ROUTES = {
  remote_snapshot: { methodId: 'remote.snapshot' },
  remote_peers: { methodId: 'remote.peers.list' },
  remote_work: { methodId: 'remote.work.list' },
  remote_pair_requests: { methodId: 'remote.pair.requests.list' },
  remote_pair_approve: {
    methodId: 'remote.pair.requests.approve',
    action: 'Remote pair request approval',
    input: (args) => {
      const requestId = readString(args.requestId || args.target);
      if (!requestId) return missing(['requestId'], 'Call mode:"remote_pair_requests" to list pending requests, then pass requestId (or target) of the request to approve.');
      const note = readString(args.note);
      // Only an explicit true replaces an existing peer; a stringified "true" from a model is not consent.
      return { input: { requestId, ...(note ? { note } : {}), ...(args.confirmReplace === true ? { confirmReplace: true } : {}) } };
    },
  },
  remote_pair_reject: {
    methodId: 'remote.pair.requests.reject',
    action: 'Remote pair request rejection',
    input: (args) => {
      const requestId = readString(args.requestId || args.target);
      if (!requestId) return missing(['requestId'], 'Call mode:"remote_pair_requests" to list pending requests, then pass requestId (or target) of the request to reject.');
      const note = readString(args.note);
      return { input: { requestId, ...(note ? { note } : {}) } };
    },
  },
  remote_peers_invoke: {
    methodId: 'remote.peers.invoke',
    action: 'Remote peer command invocation',
    input: (args) => {
      const peerId = readString(args.peerId || args.target);
      const command = readString(args.command);
      const absent = [...(peerId ? [] : ['peerId']), ...(command ? [] : ['command'])];
      if (absent.length > 0) return missing(absent, 'Call mode:"remote_peers" to list peers, then pass peerId (or target) and the command to run.');
      const payload = args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload) ? args.payload as Record<string, unknown> : {};
      // The permission gate judges `command`; arguments sent beside it would run without being judged.
      if (payload['args'] !== undefined) {
        return missing(['command with its arguments'], 'payload.args is not accepted here: put the arguments in command itself, so the command the permission gate judges is the command that runs.');
      }
      return { input: { peerId, command, ...(Object.keys(payload).length > 0 ? { payload } : {}) } };
    },
  },
  remote_backends: { methodId: 'remote.backends.list' },
  remote_backends_register: {
    methodId: 'remote.backends.register',
    action: 'Remote backend registration',
    input: (args) => {
      const peerId = readString(args.peerId || args.target);
      const backendKind = readString(args.backendKind);
      const config = args.backendConfig && typeof args.backendConfig === 'object' && !Array.isArray(args.backendConfig)
        ? args.backendConfig as Record<string, unknown> : undefined;
      const absent = [...(peerId ? [] : ['peerId']), ...(backendKind ? [] : ['backendKind']), ...(config ? [] : ['backendConfig'])];
      if (absent.length > 0) {
        return missing(absent, 'Pass peerId (the id remote_peers_invoke will use), backendKind (docker, ssh, cloud-terminal or local-process) and backendConfig (credentials as goodvibes://secrets/ references only).');
      }
      const displayName = readString(args.displayName);
      return { input: { peerId, backendKind, backendConfig: config, ...(displayName ? { displayName } : {}) } };
    },
  },
  remote_backends_remove: {
    methodId: 'remote.backends.remove',
    action: 'Remote backend removal',
    input: (args) => {
      const peerId = readString(args.peerId || args.target);
      if (!peerId) return missing(['peerId'], 'Call mode:"remote_backends" to list registered backends, then pass peerId (or target) of the one to remove.');
      return { input: { peerId } };
    },
  },
  remote_work_cancel: {
    methodId: 'remote.work.cancel',
    action: 'Remote work cancellation',
    input: (args) => {
      const workId = readString(args.workId || args.target);
      if (!workId) return missing(['workId'], 'Call mode:"remote_work" to list queued and leased work, then pass workId (or target) of the item to cancel.');
      const reason = readString(args.reason);
      return { input: { workId, ...(reason ? { reason } : {}) } };
    },
  },
} as const satisfies Record<string, RemoteModeRoute>;

export type AgentHarnessRemoteMode = keyof typeof REMOTE_MODE_ROUTES;

export function isAgentHarnessRemoteMode(mode: string): mode is AgentHarnessRemoteMode {
  return Object.hasOwn(REMOTE_MODE_ROUTES, mode);
}

/** The remote modes and the operator method each one runs, for the harness summary. */
export function remoteCatalogStatus(): Record<string, unknown> {
  const modes = Object.entries(REMOTE_MODE_ROUTES as Record<string, RemoteModeRoute>);
  return {
    modes: modes.map(([mode, route]) => ({ mode, methodId: route.methodId, effect: route.action ? 'connected-host-state' : 'read' })),
    policy: 'Each remote mode runs its operator method on the connected host and returns the host\'s answer. Approving or rejecting a pair request, invoking a peer command, registering or removing a backend and cancelling work change host state and need current recorded effect admission for this call; nothing else has to be called afterwards. A paired peer gets an invoked command as queued work; a registered backend (remote_backends) runs it at once and answers with the exit code and output.',
  };
}

let remoteCallSequence = 0;

/**
 * Runs one remote mode: the mode names an operator method, and the call is made
 * through `agent_operator_method`, which owns the connection, the request and
 * what a failure means. A mode that changes host state is refused before
 * anything is sent when its id is missing or this call has no effect admission.
 */
export async function runRemoteMode(
  toolRegistry: ToolRegistry,
  mode: AgentHarnessRemoteMode,
  args: AgentHarnessRemoteArgs,
  rawArgs: Record<string, unknown>,
  options: Parameters<Tool['execute']>[1],
): Promise<RemoteResult> {
  const route: RemoteModeRoute = REMOTE_MODE_ROUTES[mode];
  const built: RemoteInput = route.input ? route.input(args) : { input: {} };
  if ('missing' in built) {
    return error(`${mode} was not run and nothing was sent: it requires ${built.missing.join(' and ')}. ${built.next}`);
  }
  if (route.action) {
    const refusal = requireConfirmedAction(rawArgs, options, route.action);
    if (refusal) return error(refusal);
  }
  if (!toolRegistry.has('agent_operator_method')) {
    return error(`${mode} was not run and nothing was sent: this Agent has no agent_operator_method tool, so it cannot reach a connected host. Connect a host (setup action:"item" setupItemId:"connected-host-auth"), then repeat the call.`);
  }
  const result = await toolRegistry.executeNested(`agent-harness-${mode}-${++remoteCallSequence}`, 'agent_operator_method',
    { methodId: route.methodId, input: built.input }, options);
  return result.success
    ? { success: true, output: result.output ?? '' }
    : { success: false, error: result.error ?? `${route.methodId} failed on the connected host.` };
}

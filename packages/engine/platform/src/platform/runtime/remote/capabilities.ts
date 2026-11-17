import type { AcpConnection } from '../store/domains/acp.js';
import type { RemoteRunnerContract } from './types.js';

export type RemoteCapabilityId =
  | 'files'
  | 'commands'
  | 'approvals'
  | 'artifacts'
  | 'resume'
  | 'containment';

export interface RemoteCapabilitySnapshot {
  readonly id: RemoteCapabilityId;
  readonly supported: boolean;
  readonly source: 'contract' | 'connection';
  readonly detail: string;
}

/**
 * What a runner may do and what holds it there. An external (ACP) runner runs
 * its own tools as a host process; this side holds it to its tools and write
 * scope at each permission ask (acp/runner-ceiling.ts), and nothing contains
 * the process itself. A local runner runs inside this runtime.
 */
export function deriveRemoteCapabilities(
  contract?: RemoteRunnerContract | null,
  connection?: AcpConnection | null,
): RemoteCapabilitySnapshot[] {
  const tools = new Set(contract?.capabilityCeiling.allowedTools ?? []);
  const writeScope = contract?.capabilityCeiling.writeScope ?? [];
  const transportState = connection?.transportState ?? contract?.transport.state ?? 'disconnected';
  const external = contract ? contract.trustClass === 'self-hosted-acp' : Boolean(connection);
  const source = contract ? 'contract' : 'connection';
  // The ceiling an external runner's permission asks are checked against: no tool list sets no tool ceiling, and a write scope refuses every command.
  const externalCommands = (tools.size === 0 || tools.has('exec')) && writeScope.length === 0;

  return [
    {
      id: 'files',
      supported: tools.has('read') || tools.has('write') || tools.has('edit') || writeScope.length > 0 || (external && tools.size === 0),
      source,
      detail: writeScope.length > 0
        ? (external ? `edits only inside ${writeScope.length} scoped path(s); an edit elsewhere is refused at its permission ask` : `${writeScope.length} scoped path(s)`)
        : 'tool-backed file access',
    },
    {
      id: 'commands',
      supported: external ? externalCommands : tools.has('exec'),
      source,
      detail: external
        ? (externalCommands ? 'commands allowed, each decided at its permission ask' : `a command's permission ask is refused (${writeScope.length > 0 ? 'it has a write scope' : 'exec is not among its tools'})`)
        : tools.has('exec') ? 'command execution allowed' : 'no command execution declared',
    },
    {
      id: 'approvals',
      supported: external ? transportState !== 'disconnected' : contract?.capabilityCeiling.reviewMode === 'contract' || transportState !== 'disconnected',
      source,
      detail: external
        ? 'its permission asks come back here: outside its ceiling they are refused, inside it decided like this session\'s own'
        : contract?.capabilityCeiling.reviewMode === 'contract'
          ? 'contract-checked remote flow'
          : 'approval continuity available through transport',
    },
    {
      id: 'artifacts',
      supported: Boolean(contract),
      source,
      detail: contract ? 'runner contract can export evidence artifacts' : 'connection only',
    },
    {
      id: 'resume',
      supported: Boolean(contract?.taskId),
      source: 'contract',
      detail: contract?.taskId ?? 'no resumable task bound',
    },
    {
      id: 'containment',
      supported: false,
      source,
      detail: external
        ? 'none: a host process with your user\'s access, held to its ceiling only at its permission asks'
        : 'runs inside this runtime; its commands go through the exec sandbox when sandbox.enabled is on and the host has bubblewrap',
    },
  ];
}

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
  const transportState = connection?.transportState ?? contract?.transport?.state ?? 'disconnected';
  const external = contract ? contract.trustClass === 'self-hosted-acp' : Boolean(connection);
  const source = contract ? 'contract' : 'connection';
  // The ceiling an external runner's permission asks are checked against: no tool list sets no tool ceiling, and a write scope refuses every command.
  const externalCommands = (tools.size === 0 || tools.has('exec')) && writeScope.length === 0;

  return [
    {
      id: 'files',
      supported: tools.has('read') || tools.has('write') || tools.has('edit') || writeScope.length > 0 || (external && tools.size === 0),
      source,
      // Said to a person: what the runner may do, in words, never the gate's or the transport's names.
      detail: writeScope.length > 0
        ? (external ? `it edits only inside the ${writeScope.length === 1 ? 'folder' : `${writeScope.length} folders`} it was given; an edit elsewhere is refused when it asks` : `only inside the ${writeScope.length === 1 ? 'folder' : `${writeScope.length} folders`} it was given`)
        : 'it reads and edits files with its own tools',
    },
    {
      id: 'commands',
      supported: external ? externalCommands : tools.has('exec'),
      source,
      detail: external
        ? (externalCommands ? 'it may run commands; each one is decided when it asks' : `a command it asks to run is refused (${writeScope.length > 0 ? 'it may write only in the folders it was given' : 'running commands is not among its tools'})`)
        : tools.has('exec') ? 'it may run commands' : 'it runs no commands',
    },
    {
      id: 'approvals',
      supported: external ? transportState !== 'disconnected' : contract?.capabilityCeiling.reviewMode === 'contract' || transportState !== 'disconnected',
      source,
      detail: external
        ? 'what it asks to do comes to you: anything outside what it may do is refused, the rest is decided as your own calls are'
        : contract?.capabilityCeiling.reviewMode === 'contract'
          ? 'its work is checked against what it was asked to do'
          : 'what it asks to do comes to you while it is connected',
    },
    {
      id: 'artifacts',
      supported: Boolean(contract),
      source,
      detail: contract ? 'what it did can be saved and reviewed in Handed back' : 'nothing is kept of what it did',
    },
    {
      id: 'resume',
      supported: Boolean(contract?.taskId),
      source: 'contract',
      detail: contract?.taskId ? 'it can go on with the task it was given' : 'it has no task it can go on with after it stops',
    },
    {
      id: 'containment',
      supported: false,
      source,
      detail: external
        ? 'it runs on this machine with your account\'s access; it is held to what it may do only when it asks'
        : 'it runs inside the daemon; its commands are kept apart from the machine when the sandbox is on and the machine has bubblewrap',
    },
  ];
}

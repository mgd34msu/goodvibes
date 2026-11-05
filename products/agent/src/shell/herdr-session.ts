import { join } from 'node:path';
import type { HerdrSessionUpdate } from '@goodvibes-jev/engine/terminal-shell';
import { sanitizeSessionName } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { HookDispatcher } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import type { ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import type { SetupPairingController } from './setup-pairing-controller.ts';
import type { InputHandler } from '../input/handler.ts';
import type { PendingPermissionState } from './blocking-input.ts';
import type { DaemonRepairPrompt } from './daemon-repair-prompt.ts';

/** Project lifecycle facts only. Prompt contents never leave the Agent. */
export function buildAgentHerdrSessionUpdate(state: {
  readonly runtime: { readonly sessionId: string };
  readonly surface: { readonly sessionsDir: string };
  readonly orchestrator: { readonly isThinking: boolean; readonly isBusy: boolean };
  readonly workingDir: string;
  readonly input?: Pick<InputHandler, 'waitingForOwner'>;
  readonly hookDispatcher?: Pick<HookDispatcher, 'activeInvocationCount'>;
  readonly fleetNodes?: readonly Pick<ProcessNode, 'kind' | 'state' | 'sessionRef'>[];
  readonly setupPairing?: Pick<SetupPairingController, 'waitingForOwner'> | null;
  readonly contracts?: readonly { readonly status: ContractView['status']; readonly groups: readonly Pick<ContractView['groups'][number], 'status'>[]; readonly units: readonly Pick<ContractView['units'][number], 'status'>[] }[];
  readonly pendingPermission?: PendingPermissionState | null;
  readonly recoveryPending?: string | null;
  readonly daemonRepairPrompt?: Pick<DaemonRepairPrompt, 'pending'> | null;
}): HerdrSessionUpdate {
  const { input, runtime } = state;
  return {
    sessionId: runtime.sessionId,
    sessionPath: join(state.surface.sessionsDir, `${sanitizeSessionName(runtime.sessionId)}.jsonl`),
    busy: state.orchestrator.isBusy || state.orchestrator.isThinking
      || (state.hookDispatcher?.activeInvocationCount ?? 0) > 0
      || state.contracts?.some(contract => !['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(contract.status)) === true
      || state.fleetNodes?.some(node => node.kind === 'agent' && node.sessionRef?.sessionId === runtime.sessionId
        && ['queued', 'thinking', 'executing-tool', 'streaming', 'stalled', 'retrying'].includes(node.state)) === true,
    waitingForOwner: state.pendingPermission != null || state.recoveryPending != null
      || state.daemonRepairPrompt?.pending() === true || state.setupPairing?.waitingForOwner === true
      || state.fleetNodes?.some(node => node.kind === 'agent' && node.sessionRef?.sessionId === runtime.sessionId
        && node.state === 'awaiting-approval') === true
      || state.contracts?.some(contract => contract.status === 'awaiting-owner'
        || contract.groups.some(group => group.status === 'awaiting-owner')
        || contract.units.some(unit => unit.status === 'awaiting-owner')) === true
      || input?.waitingForOwner === true,
    resumeArgv: ['goodvibes-agent', '--working-dir', state.workingDir, '--resume', runtime.sessionId],
  };
}

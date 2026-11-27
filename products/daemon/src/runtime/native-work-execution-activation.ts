/** Lazy daemon-owned native graph; ordinary conversations keep their own runner. */
import { createAgentExecutionGraph } from '@goodvibes/engine/platform/platform/runtime/operations';
import { ProcessManager, TURN_EXEC_CONTAINMENT, cancelAllAgentRuns, type AgentFleetOwnership } from '@goodvibes/engine/platform/platform/tools';
import type { AgentOrchestrator } from '@goodvibes/engine/platform/platform/agents';
import type { PermissionManager } from '@goodvibes/engine/platform/platform/permissions';
import { NativeWorkExecutionError, type NativeWorkExecutionHost } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution';
import { createDaemonNativeWorkExecutionServices } from './native-work-execution-composition.js';
import type { ContractOperatorService } from '@goodvibes/engine/platform/platform/contract';
import { createNativeWorkSessionDriver, type NativeSessionDriverOptions } from './native-work-session-driver.js';
import { UNRECORDED_WORK_CAUSE, type WorkCause } from '@goodvibes/engine/platform/platform/workflow/work-ledger';
import { logger, outsideEveryCall } from '@goodvibes/engine/platform/platform/utils';
import { ownersChannelSession } from '@goodvibes/engine/platform/platform/security';

type NativeOptions = Parameters<typeof createDaemonNativeWorkExecutionServices>[0];
export type NativeWorkExecutionActivationOptions = Omit<NativeOptions, 'agentManager' | 'agentMessageBus' | 'readAccessFilter' | 'cancelForeground' | 'releaseForeground'> & {
  readonly permissionManager: PermissionManager;
  readonly toolDependencies: Parameters<AgentOrchestrator['setDependencies']>[0];
  readonly featureFlags: NativeSessionDriverOptions['featureFlags'];
  readonly hookDispatcher: NativeSessionDriverOptions['hookDispatcher'];
  readonly retry?: NativeSessionDriverOptions['retry'];
  /** Where the owner answers a paused turn's retry-or-cancel question; absent, that question cannot be answered over the operator surface. */
  readonly contractOperator?: Pick<ContractOperatorService, 'attachNative'> | undefined;
  /**
   * Told each time native work frees a slot of the shared fleet (an agent of its
   * graph or a session turn ended): the daemon's own manager, whose releases
   * `onFleetSlotReleased` then subscribes to for the native contract engine.
   */
  readonly notifyFleetSlotReleased?: (() => void) | undefined;
};

/** Public lifetime boundary: opaque execution authority stays behind the engine host type. */
export interface NativeWorkExecutionActivation {
  readonly fleetOwnership: () => readonly AgentFleetOwnership[];
  acquire(): Promise<NativeWorkExecutionHost>;
  close(): Promise<void>;
}

export function createDaemonNativeWorkExecutionActivation(options: NativeWorkExecutionActivationOptions): NativeWorkExecutionActivation {
  /** One part of the close, traced in the ordinary log at debug level: a stop that hangs names the part it waits on. */
  const closeStep = <T>(part: string, pending: Promise<T>): Promise<T> => {
    const from = Date.now();
    logger.debug(`Work of ${options.projectRoot}: closing, waiting on ${part}`);
    void pending.then(() => { logger.debug(`Work of ${options.projectRoot}: ${part} closed`, { ms: Date.now() - from }); }, () => {});
    return pending;
  };
  let closed = false;
  let opening: Promise<Awaited<ReturnType<typeof build>>> | undefined;
  let closing: Promise<void> | undefined;
  let localFleetOwnership: NonNullable<NativeOptions['additionalFleetOwnership']> = () => [];
  let foregroundFleetOwnership: typeof localFleetOwnership = () => [];
  async function build() {
    const graph = createAgentExecutionGraph({ runtimeBus: options.runtimeBus, workingDirectory: options.projectRoot,
      configManager: options.configManager, providerRegistry: options.providerRegistry,
      additionalFleetOwnership: () => [...(options.additionalFleetOwnership?.() ?? []), ...foregroundFleetOwnership(),
        ...options.acpHost.fleetOwnership()] });
    localFleetOwnership = () => {
      const agents = new Map<string, boolean>();
      for (const agent of [...graph.agentManager.fleetOwnership(), ...foregroundFleetOwnership()])
        agents.set(agent.id, agents.get(agent.id) === true || agent.active);
      return Object.freeze([...agents].map(([id, active]) => Object.freeze({ id, active })));
    };
    const releaseSlot = (): void => { options.notifyFleetSlotReleased?.(); };
    graph.agentManager.onFleetSlotReleased(releaseSlot);
    graph.agentOrchestrator.setCancellationSource({ get: id => graph.agentManager.getCancellationSignal(id) });
    graph.agentOrchestrator.setFeatureFlagManager(options.featureFlags);
    const processManager = new ProcessManager();
    let native: Awaited<ReturnType<typeof createDaemonNativeWorkExecutionServices>> | undefined;
    let cancelForeground: (contractId: string) => Promise<void> = async () => { throw new NativeWorkExecutionError('unavailable'); };
    let joinForeground: (contractId: string) => Promise<void> = async () => { throw new NativeWorkExecutionError('unavailable'); };
    let releaseForeground: (contractId: string) => void = () => {};
    try {
      native = await createDaemonNativeWorkExecutionServices({ ...options,
        agentManager: graph.agentManager, agentMessageBus: graph.agentMessageBus,
        cancelForeground: contractId => cancelForeground(contractId),
        joinForeground: contractId => joinForeground(contractId),
        releaseForeground: contractId => releaseForeground(contractId),
        additionalFleetOwnership: () => [...(options.additionalFleetOwnership?.() ?? []), ...foregroundFleetOwnership()],
        readAccessFilter: async path => (await options.permissionManager.readAccess(path)) === 'allow',
        admitSetupCommand: async (command, cwd) => {
          const decision = await options.permissionManager.checkDetailed('exec', { commands: [{ cmd: command }], working_dir: cwd });
          return decision.approved ? { allowed: true } : { allowed: false, reason: `the permission check refused it (${decision.reasonCode})` };
        } });
      const toolDependencies = { ...options.toolDependencies, ...graph, processManager,
        // The ordinary remote runner registry owns the ordinary manager.
        remoteRunnerRegistry: undefined,
        // The one rule every turn's commands follow; someone else's work is held to the boundary at the command.
        execContainment: TURN_EXEC_CONTAINMENT,
        contractRunner: native.runner, contractHooks: native.runner.hooks(), permissionManager: options.permissionManager };
      graph.agentOrchestrator.setDependencies(toolDependencies);
      const owner = native;
      // Who caused each piece of work, from its record: its session turns and its agents run as that party (the owner's
      // own only when the owner in person asked for it or approved it; anyone else's runs reads only, no command outside a
      // real sandbox). Read at every turn and wake, so the owner's approval since the work started counts.
      // Work a channel conversation caused, with no cause of its own on record, is the owner's own when that conversation
      // is theirs alone on a channel that proves its sender (their message there, agreed by them there): the same rule their own channel turns follow (security/turn-input-party.ts). A guest's, a group's or any
      // other conversation's stays someone else's.
      const workCauseOf = (sessionId: string | undefined): WorkCause => {
        const recorded = options.workPlans?.causeOfSession(sessionId) ?? UNRECORDED_WORK_CAUSE;
        return recorded === UNRECORDED_WORK_CAUSE && ownersChannelSession(sessionId) ? { party: 'owner' } : recorded;
      };
      graph.agentManager.setWorkParty((record) => {
        if (!record.contractId) return undefined;
        return workCauseOf(owner.runner.get(record.contractId)?.sessionId);
      });
      const driver = createNativeWorkSessionDriver({ ...options, runner: owner.runner, toolDependencies, onSlotReleased: releaseSlot, workCauseOf,
        // A unit's turn is assembled the one way (its project's environment from this graph's orchestrator).
        turnEnvironment: (folder) => graph.agentOrchestrator.acquireTurnEnvironment(folder),
        assertCurrent: contract => { owner.execution.nativeOwner.decisions.authorityOf(contract); } });
      foregroundFleetOwnership = driver.fleetOwnership;
      // This project's Work runner beside the other projects' (the operator reads and answers each project's own work).
      const detachNative = options.contractOperator?.attachNative(owner.runner);
      cancelForeground = driver.cancel;
      joinForeground = driver.join;
      releaseForeground = driver.release;
      let drain: Promise<void> | undefined;
      async function cancelWithForeground(workId: string, attemptId: string, authority: Parameters<typeof owner.execution.cancel>[1], operation: () => Promise<void>) {
        const read = () => owner.execution.statusByAttempt(workId, attemptId, authority);
        let observed: ReturnType<typeof read> | undefined;
        try { observed = read(); } catch (error) { if (!(error instanceof NativeWorkExecutionError) || error.code !== 'not-found') throw error; }
        const receipt = observed?.kind === 'execution' ? observed.execution.receipt : null;
        // Existing effects are fenced before the durable operation can await.
        // Intent-only cancellation still reaches the host and may win first.
        const fenced = new Set<string>();
        if (receipt) fenced.add(receipt.contractId);
        const foreground = receipt ? driver.cancel(receipt.contractId) : Promise.resolve();
        const results = await Promise.allSettled([Promise.resolve().then(operation), foreground]);
        let failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
        try {
          // Association publication may have won after the first observation.
          // Join its actual foreground lifetime before reporting cancellation.
          const latest = read();
          if (latest.kind === 'execution' && latest.execution.receipt) {
            fenced.add(latest.execution.receipt.contractId);
            await driver.cancel(latest.execution.receipt.contractId);
          }
        } catch (error) { failure ??= error; }
        if (failure !== undefined) {
          // A refused cancellation leaves its contract running; a committed one
          // has already made it terminal. The driver decides from that status.
          for (const contractId of fenced) driver.release(contractId);
          throw failure;
        }
      }
      const execution = { ...owner.execution,
        cancel(...args: Parameters<typeof owner.execution.cancel>) {
          return cancelWithForeground(args[0].workId, args[0].attemptId, args[1], () => owner.execution.cancel(...args));
        },
        cancelTarget(...args: Parameters<typeof owner.execution.cancelTarget>) {
          return cancelWithForeground(args[0].workId, args[0].attemptId, args[1], () => owner.execution.cancelTarget(...args));
        },
      };
      return { execution, close() {
        if (drain) return drain;
        detachNative?.();
        // Fence admission, abort foreground turns and cancel background work
        // before waiting on any one of their drains. The runner is told first that the daemon is closing: the agents
        // cancelled here end with it, which neither stops nor fails the work (it stands interrupted at the next start).
        owner.runner.prepareToClose?.();
        // Told so, the runner no longer ends a run when its owner record is cancelled: each run ends here, its restart
        // checkpoint kept, before anything below waits on it (the owner record's join waits for its run).
        owner.endRuns();
        const execution = closeStep('execution', owner.execution.close());
        const sessions = closeStep('session turns', driver.close());
        cancelAllAgentRuns(graph.agentManager);
        const agents = closeStep('agents', Promise.allSettled(graph.agentManager.list().map(record => graph.agentManager.join(record.id))));
        const processes = closeStep('processes', processManager.close());
        drain = Promise.allSettled([execution, sessions, agents, processes]).then(async results => {
          try { await closeStep('runner', owner.close()); } finally { graph.agentOrchestrator.dispose(); localFleetOwnership = () => []; }
          const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
          if (errors.length) throw new AggregateError(errors, 'Native execution cleanup failed');
        });
        return drain;
      } };
    } catch (error) {
      cancelAllAgentRuns(graph.agentManager);
      try { await Promise.allSettled([native?.close(), processManager.close(), ...graph.agentManager.list().map(record => graph.agentManager.join(record.id))]); }
      finally { graph.agentOrchestrator.dispose(); localFleetOwnership = () => []; }
      throw error;
    }
  }
  return {
    /** Read-only resource ownership; no manager/control handle escapes. */
    fleetOwnership: () => localFleetOwnership(),
    async acquire() {
      if (closed) throw new NativeWorkExecutionError('closed');
      if (!opening) {
        // Opened by whichever request first needs it: its runner, driver and workers are no caller's (outsideEveryCall).
        const pending = outsideEveryCall(() => build()); opening = pending;
        void pending.catch(() => { if (opening === pending && !closed) opening = undefined; });
      }
      const owner = await opening;
      if (closed) { await owner.close(); throw new NativeWorkExecutionError('closed'); }
      return owner.execution;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = opening ? opening.then(owner => owner.close(), () => {}) : Promise.resolve();
      return closing;
    },
  };
}

/** Lazy daemon-owned native graph; ordinary conversations keep their own runner. */
import { createAgentExecutionGraph } from '@goodvibes/engine/platform/platform/runtime/operations';
import { WORKSTREAM_CONTAINMENT } from '@goodvibes/engine/platform/platform/hosted-sessions';
import { ProcessManager, cancelAllAgentRuns, type AgentFleetOwnership } from '@goodvibes/engine/platform/platform/tools';
import type { AgentOrchestrator } from '@goodvibes/engine/platform/platform/agents';
import type { PermissionManager } from '@goodvibes/engine/platform/platform/permissions';
import { NativeWorkExecutionError, type NativeWorkExecutionHost } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution';
import { createDaemonNativeWorkExecutionServices } from './native-work-execution-composition.js';
import type { ContractOperatorService } from '@goodvibes/engine/platform/platform/contract';
import { createNativeWorkSessionDriver, type NativeSessionDriverOptions } from './native-work-session-driver.js';

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
        // A composed workstream the owner authorized: the boundary where available, the host where not.
        execContainment: WORKSTREAM_CONTAINMENT,
        contractRunner: native.runner, contractHooks: native.runner.hooks(), permissionManager: options.permissionManager };
      graph.agentOrchestrator.setDependencies(toolDependencies);
      const owner = native;
      const driver = createNativeWorkSessionDriver({ ...options, runner: owner.runner, toolDependencies, onSlotReleased: releaseSlot,
        assertCurrent: contract => { owner.execution.nativeOwner.decisions.authorityOf(contract); } });
      foregroundFleetOwnership = driver.fleetOwnership;
      options.contractOperator?.attachNative(owner.runner);
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
        options.contractOperator?.attachNative(null);
        // Fence admission, abort foreground turns and cancel background work
        // before waiting on any one of their drains.
        const execution = owner.execution.close();
        const sessions = driver.close();
        cancelAllAgentRuns(graph.agentManager);
        const agents = Promise.allSettled(graph.agentManager.list().map(record => graph.agentManager.join(record.id)));
        const processes = processManager.close();
        drain = Promise.allSettled([execution, sessions, agents, processes]).then(async results => {
          try { await owner.close(); } finally { graph.agentOrchestrator.dispose(); localFleetOwnership = () => []; }
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
        const pending = build(); opening = pending;
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

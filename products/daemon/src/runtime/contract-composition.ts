/** The daemon composes one canonical runner after its plan and fleet owners exist. */
import { composeContractRunner, makeRuntimeFleetProbe, type ContractRunnerCompositionOptions } from '@goodvibes/engine/platform/platform/runtime/operations';
import { createContractOperatorService } from '@goodvibes/engine/platform/platform/contract';

export type DaemonContractCompositionOptions = Omit<ContractRunnerCompositionOptions, 'fleetCapacity' | 'readAccessFilter'> & {
  readonly readAccessFilter: NonNullable<ContractRunnerCompositionOptions['readAccessFilter']>;
  /** Read by the native-work activation, which folds the hosted sessions into its manager's fleet ownership. */
  readonly acpHost: { list(): readonly { readonly id: string }[] };
  /** Trusted sibling execution graphs, not observed external processes; folded into the manager's fleet ownership by the caller. */
  readonly additionalFleetOwnership?: (() => ReturnType<ContractRunnerCompositionOptions['agentManager']['fleetOwnership']>) | undefined;
};

export function createDaemonContractServices(options: DaemonContractCompositionOptions) {
  // The manager's fleetCount already counts its siblings and the hosted ACP
  // sessions (both are composed into its fleet ownership), so the pool reads the
  // same number every spawn admission reads.
  const fleetCapacity = makeRuntimeFleetProbe({
    readConfig: (key) => options.configManager.get(key as Parameters<typeof options.configManager.get>[0]),
    fleet: options.agentManager,
  });
  const contracts = composeContractRunner({ ...options, nativeDataWriter: options.nativeDataWriter ?? options.configManager.getNativeDataWriter(), fleetCapacity });
  const operator = createContractOperatorService({ runner: contracts.runner, workingDirectory: options.projectRoot });
  return { ...contracts, operator };
}

import type { PairingTokenManager } from '@goodvibes/engine/platform/platform/pairing';
import { checkSettings, readContractConfig } from '@goodvibes/engine/platform/platform/contract';
import { realpathSync } from 'node:fs';
import type { KnowledgeStore } from '@goodvibes/engine/platform/platform/knowledge';
import { createNativeWorkExecutionHost } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution';
import type { NativeExecutionScopeOwner } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution';
import type { JudgmentPort, DecisionLog } from '@goodvibes/judgment';
import { createDaemonContractServices, type DaemonContractCompositionOptions } from './contract-composition.js';
import { createDaemonContinuationPolicy } from './native-continuation-policy.js';

/**
 * Explicit native floor composition. The caller owns this graph's manager and
 * orchestrator; historical daemon/Agent/TUI entrypoints remain unchanged.
 * Native scope and paired authority never come from serialized product input.
 */
export async function createDaemonNativeWorkExecutionServices(options: Omit<DaemonContractCompositionOptions, 'nativeOwner' | 'readAccessFilter'> & {
  readonly projectId: string;
  readonly sessionId: string;
  readonly knowledgeStore: Pick<KnowledgeStore, 'openNativeWorkExecutionStorage'>;
  readonly nativeScopes: NativeExecutionScopeOwner;
  readonly continuationScopeOwner?: { current(): { readonly revision: string; readonly scopes: readonly string[] } };
  readonly continuationGrants?: Pick<PairingTokenManager, 'readNativeContinuation' | 'withNativeContinuation' | 'consumeNativeContinuation' | 'revokeNativeContinuation' | 'bindNativeContinuationWatch' | 'issueNativeContinuationFromGrant' | 'revokeNativeContinuationsForSource'>;
  readonly judgmentPort: JudgmentPort;
  readonly decisionLog: Pick<DecisionLog, 'get'>;
  readonly cancelForeground?: (contractId: string) => Promise<void>;
  readonly joinForeground?: (contractId: string) => Promise<void>;
  readonly releaseForeground?: (contractId: string) => void;
  readonly readAccessFilter: NonNullable<DaemonContractCompositionOptions['readAccessFilter']>;
  /** A piece of work's plan before it runs ("Show me the plan before it runs"). */
  readonly workPlans?: Pick<import('@goodvibes/engine/platform/platform/workflow/work-ledger').WorkPlans, 'gate' | 'started'> | undefined;
}) {
  const continuationOwner = options.continuationScopeOwner;
  const continuationPolicy = continuationOwner ? createDaemonContinuationPolicy(options.configManager, continuationOwner) : undefined;
  const storage = await options.knowledgeStore.openNativeWorkExecutionStorage(options.projectId);
  const execution = createNativeWorkExecutionHost({ projectId: options.projectId, projectRoot: options.projectRoot,
    getSelectedModel: () => options.providerRegistry.getCurrentModel(),
    sessionId: options.sessionId, storage, scopes: options.nativeScopes, port: options.judgmentPort, decisionLog: options.decisionLog,
    ...(options.continuationGrants ? { continuationGrants: options.continuationGrants } : {}),
    ...(continuationPolicy ? { continuationPolicy } : {}),
    verification: { settings: () => checkSettings(readContractConfig(options.configManager)), readAccessFilter: options.readAccessFilter },
    ...(options.cancelForeground ? { cancelForeground: options.cancelForeground } : {}),
    ...(options.joinForeground ? { joinForeground: options.joinForeground } : {}),
    ...(options.releaseForeground ? { releaseForeground: options.releaseForeground } : {}),
    ...(options.workPlans ? { plans: options.workPlans } : {}) });
  try {
    const contracts = createDaemonContractServices({ ...options, nativeDataWriter: options.nativeDataWriter ?? options.configManager.getNativeDataWriter(), projectRoot: realpathSync(options.projectRoot), nativeOwner: execution.nativeOwner });
    execution.attachRunner(contracts.runner);
    let closing: Promise<void> | undefined;
    return { execution, runner: contracts.runner, close() {
      return closing ??= execution.close().finally(() => contracts.dispose());
    } };
  } catch (error) { await execution.close(); throw error; }
}

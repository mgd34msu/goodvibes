import { decisionOrClassic } from '../runtime/decision-policy.js';
import { rankClassicCatalog } from '../runtime/classic-catalog.js';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { retainOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { prepareJudgmentResult } from '../gate/judgment-result.js';
import { requireActingReading } from '../types/judgment-held.js';
import { hookContractCandidate, hookContractSearch } from './batteries/contract-search.js';
import type { HookPointContract } from './contracts.js';
import type { HookChain, HookDefinition, HookType } from './types.js';
import type {
  HookAuthoringAction,
  HookConfigInspection,
  HookSimulationResult,
} from './workbench.js';

export interface HookContractRecord extends HookPointContract {
  readonly provenance?: 'classic';
  readonly scoreSource?: 'literal-overlap';
}

export interface HookWorkbenchApi {
  getFilePath(): string;
  listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  listManagedChains(): HookChain[];
  listRecentActions(limit?: number): HookAuthoringAction[];
  load(path?: string): void;
  reload(path?: string): Promise<void>;
  scaffoldHook(name: string, match: string, type: HookType): Promise<HookDefinition>;
  scaffoldChain(name: string, matches: readonly string[]): Promise<HookChain>;
  remove(name: string): Promise<boolean>;
  toggle(name: string, enabled: boolean): Promise<boolean>;
  simulate(eventPath: string, payload?: Record<string, unknown>): HookSimulationResult;
  inspect(path: string): HookConfigInspection;
  export(path: string): Promise<string>;
  /** Resolves with each bundle entry that was left out, with its reason; empty when everything was taken. */
  import(path: string, strategy?: 'merge' | 'replace'): Promise<readonly string[]>;
}

export interface HookApiDispatcher {
  listHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  listChains(): HookChain[];
}

/**
 * Adapts the live dispatcher to the hook API's dispatcher view. The chains
 * listed are the ones the dispatcher is running, which include chains added at
 * runtime, not only the managed file's.
 */
export function createHookApiDispatcher(dispatcher: {
  listHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  getChains(): HookChain[];
}): HookApiDispatcher {
  return {
    listHooks: () => dispatcher.listHooks(),
    listChains: () => dispatcher.getChains(),
  };
}

export interface HookApiWorkbenchRuntime {
  getHooksFilePath(): string;
  listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  listManagedChains(): HookChain[];
  listRecentActions(limit?: number): HookAuthoringAction[];
  loadManagedConfig(path?: string): void;
  loadAndApplyManagedHooks(path?: string): Promise<void>;
  assertHooksFileTrusted(path?: string): void;
  scaffoldHook(name: string, match: string, type: HookType): HookDefinition;
  scaffoldChain(name: string, matches: readonly string[]): HookChain;
  removeManagedEntry(name: string): boolean;
  toggleManagedHook(name: string, enabled: boolean): boolean;
  simulate(eventPath: string, payload?: Record<string, unknown>): HookSimulationResult;
  inspectManagedConfig(path: string): HookConfigInspection;
  exportManagedConfig(path: string): Promise<string>;
  importManagedConfig(path: string, strategy?: 'merge' | 'replace'): void;
  getLastImportRejections(): readonly string[];
  saveManagedConfig(path?: string): Promise<void>;
}

export interface HookContractSource {
  listContracts(): readonly HookPointContract[];
}

export interface HookApi {
  /**
   * The hook point contracts, all of them for a blank filter; otherwise the
   * ones selected under the active decision policy for the filter
   * (`engine.hooks.contract-search`), in catalog order.
   */
  contracts(filter?: string): Promise<readonly HookContractRecord[]>;
  dispatcher: {
    listHooks(): Array<{ pattern: string; hook: HookDefinition }>;
    listChains(): HookChain[];
  };
  workbench: HookWorkbenchApi;
}

export interface CreateHookApiOptions {
  readonly dispatcher: HookApiDispatcher;
  readonly workbench: HookApiWorkbenchRuntime;
  readonly listContracts: HookContractSource['listContracts'];
}

/** Decision site for the contract search. */
export const HOOK_CONTRACT_SEARCH_SITE = 'hooks.contract-search';

export function createHookApi(options: CreateHookApiOptions): HookApi {
  // Each authoring verb reads the file, changes it and writes it back, so two
  // overlapping verbs would each start from the same file and the later write
  // would drop the earlier change. They run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(verb: () => Promise<T>): Promise<T> => {
    const run = queue.then(verb, verb);
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    async contracts(filter?: string): Promise<readonly HookContractRecord[]> {
      const contracts = options.listContracts();
      const query = filter?.trim() ?? '';
      if (query.length === 0) return contracts;
      const original = retainOwnedJson(contracts);
      snapshotJudgmentInput({ query, contracts: original.snapshot });
      const identity = JSON.stringify(original.snapshot);
      const current = () => {
        original.assertCurrent();
        if (JSON.stringify(snapshotJudgmentInput(options.listContracts())) !== identity) throw new Error('Hook contract catalog changed during search.');
      };
      return decisionOrClassic(async () => {
        const owner = captureJudgmentPort(HOOK_CONTRACT_SEARCH_SITE, { assertCurrent: current, prepareResultCapture: prepareJudgmentResult });
        const { ranked } = await hookContractSearch.rerank(
          owner.port,
          query,
          contracts.map(hookContractCandidate),
          { site: HOOK_CONTRACT_SEARCH_SITE, signal: owner.signal, beforeAttempt: owner.assertCurrent },
        );
        owner.assertCurrent();
        for (const entry of ranked) requireActingReading(entry.reading);
        const matched = new Set(ranked.filter((entry) => entry.reading.verdict === 'yes').map((entry) => entry.id));
        return contracts.filter((contract) => matched.has(contract.pattern));
      }, () => {
        current();
        const matches = rankClassicCatalog(contracts, query, contract => ({ id: contract.pattern,
          description: `${contract.description} ${contract.authority} ${contract.executionMode}` }))
          .map(match => ({ ...match.entry, provenance: 'classic' as const, scoreSource: 'literal-overlap' as const }));
        current();
        return matches;
      });
    },
    dispatcher: {
      listHooks(): Array<{ pattern: string; hook: HookDefinition }> {
        return options.dispatcher.listHooks();
      },
      listChains(): HookChain[] {
        return options.dispatcher.listChains();
      },
    },
    workbench: {
      getFilePath(): string {
        return options.workbench.getHooksFilePath();
      },
      listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }> {
        return options.workbench.listManagedHooks();
      },
      listManagedChains(): HookChain[] {
        return options.workbench.listManagedChains();
      },
      listRecentActions(limit = 8): HookAuthoringAction[] {
        return options.workbench.listRecentActions(limit);
      },
      load(path?: string): void {
        options.workbench.loadManagedConfig(path);
      },
      reload(path?: string): Promise<void> {
        return serialized(() => options.workbench.loadAndApplyManagedHooks(path));
      },
      scaffoldHook(name: string, match: string, type: HookType): Promise<HookDefinition> {
        return serialized(async () => {
          options.workbench.loadManagedConfig();
          options.workbench.assertHooksFileTrusted();
          const hook = options.workbench.scaffoldHook(name, match, type);
          await options.workbench.saveManagedConfig();
          await options.workbench.loadAndApplyManagedHooks();
          return hook;
        });
      },
      scaffoldChain(name: string, matches: readonly string[]): Promise<HookChain> {
        return serialized(async () => {
          options.workbench.loadManagedConfig();
          options.workbench.assertHooksFileTrusted();
          const chain = options.workbench.scaffoldChain(name, matches);
          await options.workbench.saveManagedConfig();
          await options.workbench.loadAndApplyManagedHooks();
          return chain;
        });
      },
      remove(name: string): Promise<boolean> {
        return serialized(async () => {
          options.workbench.loadManagedConfig();
          options.workbench.assertHooksFileTrusted();
          const removed = options.workbench.removeManagedEntry(name);
          if (!removed) {
            return false;
          }
          await options.workbench.saveManagedConfig();
          await options.workbench.loadAndApplyManagedHooks();
          return true;
        });
      },
      toggle(name: string, enabled: boolean): Promise<boolean> {
        return serialized(async () => {
          options.workbench.loadManagedConfig();
          options.workbench.assertHooksFileTrusted();
          const changed = options.workbench.toggleManagedHook(name, enabled);
          if (!changed) {
            return false;
          }
          await options.workbench.saveManagedConfig();
          await options.workbench.loadAndApplyManagedHooks();
          return true;
        });
      },
      simulate(eventPath: string, payload: Record<string, unknown> = {}): HookSimulationResult {
        options.workbench.loadManagedConfig();
        return options.workbench.simulate(eventPath, payload);
      },
      inspect(path: string): HookConfigInspection {
        return options.workbench.inspectManagedConfig(path);
      },
      export(path: string): Promise<string> {
        return serialized(async () => {
          options.workbench.loadManagedConfig();
          return options.workbench.exportManagedConfig(path);
        });
      },
      import(path: string, strategy: 'merge' | 'replace' = 'merge'): Promise<readonly string[]> {
        return serialized(async () => {
          options.workbench.loadManagedConfig();
          options.workbench.assertHooksFileTrusted();
          options.workbench.importManagedConfig(path, strategy);
          // Read before the reload below, which starts from a cleared workbench.
          const rejected = [...options.workbench.getLastImportRejections()];
          await options.workbench.saveManagedConfig();
          await options.workbench.loadAndApplyManagedHooks();
          return rejected;
        });
      },
    },
  };
}

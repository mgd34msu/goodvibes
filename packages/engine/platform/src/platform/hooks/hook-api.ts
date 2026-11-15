import { judge } from '../runtime/judge.js';
import { rankClassicCatalog } from '../runtime/classic-catalog.js';
import { hookContractSearch } from './batteries/contract-search.js';
import type { HookPointContract } from './contracts.js';
import type { HookChain, HookDefinition, HookType } from './types.js';
import type {
  HookAuthoringAction,
  HookConfigInspection,
  HookSimulationResult,
} from './workbench.js';

export interface HookContractRecord extends HookPointContract {
  /** Set when code chose the entry from the filter's words, without a decision model. */
  readonly provenance?: 'classic';
  readonly scoreSource?: 'literal-overlap';
  /** Set when the decision model could not say whether the entry fits the filter; it is listed anyway. */
  readonly unsure?: true;
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
   * The hook point contracts, all of them for a blank filter. Otherwise the
   * ones whose phase, category, specific or description match every word of
   * the filter, in catalog order; only when none does, one decision-model
   * request (`engine.hooks.contract-search`) picks them, and with no model
   * the literal-overlap ranking does.
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

const FILTER_FILLER = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'on', 'in', 'at', 'and', 'or', 'is', 'it', 'when', 'hook', 'hooks', 'point', 'points', 'event', 'events']);
const FILTER_SYNONYMS: Readonly<Record<string, string>> = {
  before: 'pre', after: 'post', failed: 'fail', failure: 'fail', failures: 'fail', error: 'fail', errors: 'fail',
  changed: 'change', changes: 'change', model: 'llm', setting: 'config', settings: 'config',
};

function filterWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}

/** A filter word fits a field word when they are equal or one is a prefix of the other (three letters or more). */
function wordFits(query: string, field: string): boolean {
  if (query === field) return true;
  if (query.length >= 3 && field.startsWith(query)) return true;
  return field.length >= 4 && query.startsWith(field);
}

/** Hook points whose pattern segments or description words fit every word of the filter, in catalog order. */
function localContractMatches(contracts: readonly HookPointContract[], query: string): HookContractRecord[] {
  const words = filterWords(query).filter((word) => !FILTER_FILLER.has(word)).map((word) => FILTER_SYNONYMS[word] ?? word);
  if (words.length === 0) return [...contracts];
  return contracts
    .filter((contract) => {
      const fields = [...filterWords(contract.pattern.replaceAll('*', ' ')), ...filterWords(contract.description), contract.authority, contract.executionMode.replace('_', '')];
      return words.every((word) => fields.some((field) => wordFits(word, field)));
    })
    .map((contract) => ({ ...contract, provenance: 'classic' as const, scoreSource: 'literal-overlap' as const }));
}

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
      const local = localContractMatches(contracts, query);
      if (local.length > 0) return local;
      const asked = contracts.map((contract) => contract.pattern).filter((pattern) => pattern in hookContractSearch.items);
      if (asked.length === 0) return [];
      const { value } = await judge({
        site: HOOK_CONTRACT_SEARCH_SITE,
        battery: hookContractSearch,
        state: { query },
        only: asked,
        cache: { key: query, scope: 'process' },
        settle: (readings): readonly HookContractRecord[] => contracts.flatMap((contract) => {
          const verdict = readings[contract.pattern]?.verdict;
          if (verdict === 'yes') return [contract];
          return verdict === 'uncertain' ? [{ ...contract, unsure: true as const }] : [];
        }),
        fallback: (): readonly HookContractRecord[] => rankClassicCatalog(contracts, query, (contract) => ({ id: contract.pattern,
          description: `${contract.description} ${contract.authority} ${contract.executionMode}` }))
          .map((match) => ({ ...match.entry, provenance: 'classic' as const, scoreSource: 'literal-overlap' as const })),
        describe: (matches) => `listed ${matches.map((contract) => contract.pattern).join(', ') || 'none'}`,
      });
      return value;
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

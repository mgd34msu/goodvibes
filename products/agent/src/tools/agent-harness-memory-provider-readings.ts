import { decisionOrClassic, isClassicOperation, selectClassicCatalog, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { routingRegistry, memoryProviderSelect } from '@goodvibes-jev/engine/platform/platform/routing';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { capturePersonalOpsSnapshot, personalOpsJson } from './agent-harness-personal-ops-source.ts';

/** The invocation's native callbacks and source owner remain the same through producer reads and final publication. */
export function retainMemoryReadingOptions(original: CatalogRankingOptions): CatalogRankingOptions {
  const signal = original.signal, sourceOwner = original.sourceOwner, caller = original.assertCurrent, retain = original.retainCurrent;
  const assertSource = () => { signal?.throwIfAborted(); };
  const assertCurrent = () => {
    assertSource(); assertSynchronousJudgmentGuard(() => caller?.call(original), () => new ToolInputProjectionError('held')); assertSource();
  };
  const retainGuard = (guard: () => void, key?: string) => {
    assertSource(); assertSynchronousJudgmentGuard(() => retain?.call(original, guard, key), () => new ToolInputProjectionError('held')); assertSource();
  };
  assertCurrent(); retainGuard(assertSource, 'agent.memory.reading-options');
  return { signal, sourceOwner, assertCurrent, retainCurrent: retainGuard,
    ...(original.requirePreservedSource === undefined ? {} : { requirePreservedSource: original.requirePreservedSource }) };
}

export function assertMemoryCurrent(options: CatalogRankingOptions): void {
  options.signal?.throwIfAborted();
  assertSynchronousJudgmentGuard(() => options.assertCurrent?.(), () => new ToolInputProjectionError('held'));
  options.signal?.throwIfAborted();
}

function captureMemoryAuthority(decision: object & { readonly name: string }, current: CatalogRankingOptions) {
  const site = decision.name;
  const semanticFields = () => ({ items: modelReadingServicePath(decision, ['items']), instructions: modelReadingServicePath(decision, ['instructions']), fitInstructions: modelReadingServicePath(decision, ['fitInstructions']) });
  const definition = capturePersonalOpsSnapshot(semanticFields());
  const assertDefinition = () => {
    definition.assertCurrent(semanticFields());
    if (routingRegistry.get(site) !== decision) throw new ToolInputProjectionError('held');
  };
  assertDefinition(); current.retainCurrent?.(assertDefinition, `agent.memory.definition:${site}`);
  return captureJudgmentPort(site, { signal: current.signal, assertCurrent: () => { assertMemoryCurrent(current); assertDefinition(); }, prepareResultCapture: prepareJudgmentResult });
}

type MemoryDecision = object & { readonly name: string };

async function withMemoryReading<T, C>(source: unknown, options: CatalogRankingOptions, decision: MemoryDecision,
  read: (captured: unknown, authority: JudgmentPortCapture) => Promise<T>, classic: (captured: unknown) => C,
  skip?: (captured: unknown) => boolean): Promise<T | C> {
  return withConfiguredDecisionModelPolicy(() => withModelReadingSource(source, retainMemoryReadingOptions(options), async (captured, current) => {
    if (skip?.(captured)) { assertMemoryCurrent(current); return classic(captured); }
    return decisionOrClassic<T | C>(async () => {
      const authority = captureMemoryAuthority(decision, current);
      try { const result = await read(captured, authority); authority.assertCurrent(); return result; }
      finally {
        const observation = authority.consumeObservation();
        const retained = () => {
          current.signal?.throwIfAborted(); authority.signal.throwIfAborted();
          if (!isClassicOperation()) observation.assertCurrent();
        };
        current.retainCurrent?.(retained, decision.name); retained();
      }
    }, () => { assertMemoryCurrent(current); return classic(captured); },
    () => { assertMemoryCurrent(current); return true; });
  }));
}

export async function selectMemoryProvider<T>(providers: readonly T[], query: string, options: CatalogRankingOptions): Promise<T | undefined> {
  const retained = retainMemoryReadingOptions(options);
  const source = capturePersonalOpsSnapshot({ providers, query });
  const assertSource = () => source.assertCurrent({ providers, query });
  const current = () => { assertMemoryCurrent(retained); assertSource(); };
  current(); retained.retainCurrent?.(assertSource, 'agent.memory.provider-selection-source'); current();
  const scoped = { ...retained, assertCurrent: current };
  const site = memoryProviderSelect.name;
  // Return only original provider objects, after exact source/currentness checks.
  const index = await withMemoryReading({ providers, query }, scoped, memoryProviderSelect, async (captured, authority) => {
    const data = captured as { readonly providers: readonly T[]; readonly query: string };
    const run = await memoryProviderSelect.select(authority.port, { query: data.query }, data.providers.map((provider, index) => ({ id: String(index), content: personalOpsJson(provider) })), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only external-memory provider selection');
    if (run.outcome !== 'act') throw new ToolInputProjectionError('held');
    if (run.chosen === undefined) return undefined;
    const index = Number(run.chosen);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== run.chosen || providers[index] === undefined) throw new ToolInputProjectionError('held');
    return index;
  }, captured => {
    const data = captured as { readonly providers: readonly T[]; readonly query: string };
    const selected = selectClassicCatalog(data.providers.map((provider, index) => ({ provider, index })), data.query, ({ provider }) => {
      const id = provider !== null && typeof provider === 'object' && !Array.isArray(provider) ? (provider as Record<string, unknown>).id : undefined;
      return { id: typeof id === 'string' ? id : '', description: '' };
    });
    return selected?.index;
  }, captured => (captured as { readonly providers: readonly T[] }).providers.length === 0);
  current();
  return index === undefined ? undefined : providers[index];
}

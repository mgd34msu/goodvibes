import { decisionOrClassic, isClassicOperation, selectClassicCatalog, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { routingRegistry, memoryCredentialState, memoryLiveStatus, memoryProviderSelect, memoryReceiptMember, memoryRouteRole, memorySchemaCertified } from '@goodvibes-jev/engine/platform/platform/routing';
import { maskCredentialCandidates } from '@goodvibes-jev/engine/platform/platform/utils';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { capturePersonalOpsSnapshot, personalOpsEntry, personalOpsJson } from './agent-harness-personal-ops-source.ts';

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

export async function readMemoryRouteRole(source: unknown, options: CatalogRankingOptions) {
  const site = memoryRouteRole.name;
  return withMemoryReading(source, options, memoryRouteRole, async (captured, authority) => {
    const run = await memoryRouteRole.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only published external-memory operation role');
    const role = run.readings.role, form = run.readings.form;
    if (role.outcome !== 'act' || form.outcome !== 'act' || (role.choice === 'none') !== (form.choice === 'none')) throw new ToolInputProjectionError('held');
    return { role: role.choice, form: form.choice };
  }, () => ({ role: 'unassessed' as const, form: 'none' as const }));
}

export async function readMemoryCredentialState(source: unknown, options: CatalogRankingOptions) {
  const site = memoryCredentialState.name;
  return withMemoryReading(source, options, memoryCredentialState, async (captured, authority) => {
    const run = await memoryCredentialState.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only published external-memory authentication posture');
    if (run.readings.state.outcome !== 'act') throw new ToolInputProjectionError('held');
    return run.readings.state.choice === 'unknown' ? null : run.readings.state.choice;
  }, () => null);
}

export async function readMemoryLiveStatus(source: unknown, options: CatalogRankingOptions) {
  const site = memoryLiveStatus.name;
  return withMemoryReading(source, options, memoryLiveStatus, async (captured, authority) => {
    const run = await memoryLiveStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only published external-memory provider status');
    if (run.readings.status.outcome !== 'act') throw new ToolInputProjectionError('held');
    return run.readings.status.choice;
  }, () => 'unknown' as const);
}

export async function readMemoryReceiptMember(source: unknown, options: CatalogRankingOptions): Promise<boolean | null> {
  const site = memoryReceiptMember.name;
  return withMemoryReading(source, options, memoryReceiptMember, async (captured, authority) => {
    const run = await memoryReceiptMember.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only external-memory receipt membership');
    const reading = run.readings.member;
    if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new ToolInputProjectionError('held');
    return reading.verdict === 'yes';
  }, () => null);
}

export async function readMemorySchemaCertified(source: unknown, options: CatalogRankingOptions): Promise<boolean | null> {
  const site = memorySchemaCertified.name;
  return withMemoryReading(source, options, memorySchemaCertified, async (captured, authority) => {
    const run = await memorySchemaCertified.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only untyped external-memory schema publication claim');
    const reading = run.readings.certified;
    if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new ToolInputProjectionError('held');
    return reading.verdict === 'yes';
  }, () => null);
}

/**
 * Provider metadata with every credential-shaped span masked that its
 * characters do not prove harmless (maskCredentialCandidates): the same local
 * rule the journals use. No span is sent anywhere to be judged.
 */
export async function readMemoryPublicText(source: string, options: CatalogRankingOptions): Promise<string> {
  return withConfiguredDecisionModelPolicy(() => withModelReadingSource({ text: source }, retainMemoryReadingOptions(options), async (captured, current) => {
    assertMemoryCurrent(current);
    return maskCredentialCandidates(captured.text);
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

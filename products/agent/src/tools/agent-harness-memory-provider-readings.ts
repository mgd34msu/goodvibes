import { decisionOrClassic, isClassicOperation, selectClassicCatalog, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { routingRegistry, atRestCredential, memoryCredentialState, memoryLiveStatus, memoryProviderSelect, memoryReceiptMember, memoryRouteRole, memorySchemaCertified } from '@goodvibes-jev/engine/sdk/platform/routing';
import { findCredentialCandidates } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { capturePersonalOpsSnapshot, personalOpsEntry, personalOpsJson } from './agent-harness-personal-ops-source.ts';

/** The invocation's native callbacks and source owner remain the same through producer reads and final publication. */
export function retainMemoryReadingOptions(original: CatalogRankingOptions): CatalogRankingOptions {
  const fieldsCurrent = captureCatalogMethods(original, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
  const signal = original.signal, sourceOwner = original.sourceOwner, caller = original.assertCurrent, retain = original.retainCurrent;
  const callerCurrent = caller ? captureCatalogMethods(caller, ['call']) : undefined;
  const retainCurrent = retain ? captureCatalogMethods(retain, ['call']) : undefined;
  const assertSource = () => { fieldsCurrent(); callerCurrent?.(); retainCurrent?.(); signal?.throwIfAborted(); };
  const assertCurrent = () => {
    assertSource(); const result: unknown = caller?.call(original); assertSource();
    if (result !== undefined) { drainOwned(result); throw new ToolInputProjectionError('held'); }
  };
  const retainGuard = (guard: () => void, key?: string) => {
    assertSource(); const result: unknown = retain?.call(original, guard, key); assertSource();
    if (result !== undefined) { drainOwned(result); throw new ToolInputProjectionError('held'); }
  };
  assertCurrent(); retainGuard(assertSource, 'agent.memory.reading-options');
  return { signal, sourceOwner, assertCurrent, retainCurrent: retainGuard,
    ...(original.requirePreservedSource === undefined ? {} : { requirePreservedSource: original.requirePreservedSource }) };
}

export function assertMemoryCurrent(options: CatalogRankingOptions): void {
  options.signal?.throwIfAborted();
  const result: unknown = options.assertCurrent?.();
  if (result !== undefined) { drainOwned(result); throw new ToolInputProjectionError('held'); }
  options.signal?.throwIfAborted();
}

function captureMemoryAuthority(decision: object & { readonly name: string }, current: CatalogRankingOptions) {
  const site = decision.name;
  const registryCurrent = captureCatalogMethods(routingRegistry, ['get']);
  const decisionCurrent = captureCatalogMethods(decision, ['name', 'version', 'description', 'accuracyFloor', 'model', 'items', 'run', 'select', 'instructions', 'fitInstructions']);
  const semanticFields = () => ({ items: modelReadingServicePath(decision, ['items']), instructions: modelReadingServicePath(decision, ['instructions']), fitInstructions: modelReadingServicePath(decision, ['fitInstructions']) });
  const definition = capturePersonalOpsSnapshot(semanticFields());
  const assertDefinition = () => {
    registryCurrent(); decisionCurrent(); definition.assertCurrent(semanticFields());
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

/** The complete source stays protected. Classic never uses a semantic exemption to disclose a candidate credential. */
export async function readMemoryPublicText(source: string, options: CatalogRankingOptions): Promise<string> {
  return withConfiguredDecisionModelPolicy(() => withModelReadingSource({ text: source }, retainMemoryReadingOptions(options), async (captured, current) => {
    const candidates = findCredentialCandidates(captured.text);
    if (candidates.length === 0) return captured.text;
    const mask = () => {
      assertMemoryCurrent(current); let output = '', offset = 0;
      for (const candidate of candidates) { output += captured.text.slice(offset, candidate.start) + candidate.marker; offset = candidate.end; }
      return output + captured.text.slice(offset);
    };
    return decisionOrClassic(async () => {
      const site = atRestCredential.name;
      const authority = captureMemoryAuthority(atRestCredential, current);
      try {
        let output = '', offset = 0;
        for (const candidate of candidates) {
          const run = await atRestCredential.run(authority.port, { span: candidate.value, context: captured.text }, { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
          authority.assertCurrent();
          const clear = run.readings.credential.verdict === 'no';
          run.recordAction(clear ? 'keep public external-memory metadata span' : 'mask external-memory metadata span');
          output += captured.text.slice(offset, candidate.start) + (clear ? candidate.value : candidate.marker); offset = candidate.end;
        }
        authority.assertCurrent(); return output + captured.text.slice(offset);
      } finally {
        const observation = authority.consumeObservation();
        const retained = () => { current.signal?.throwIfAborted(); authority.signal.throwIfAborted(); if (!isClassicOperation()) observation.assertCurrent(); };
        current.retainCurrent?.(retained, site); retained();
      }
    }, mask, () => { assertMemoryCurrent(current); return true; });
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

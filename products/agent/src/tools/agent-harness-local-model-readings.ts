import { decisionOrClassic, isClassicOperation } from '@goodvibes-jev/engine/platform/platform/runtime';
import { declaredClassicModelStack, declaredClassicBoolean, declaredClassicServingStatus, declaredClassicResourcePressure } from '@goodvibes-jev/engine/platform/platform/routing';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { localServerIdentity, localServingStatus, localResourcePressure, localServingSchemaStatus } from '@goodvibes-jev/engine/platform/platform/routing';
import { assertProjectionCurrent, booleanValue } from '@goodvibes-jev/engine/platform/platform/tools';
import { withModelReadingSource, type ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';
import type { LocalModelServerServingDiagnostics } from './agent-harness-model-routing-types.ts';

export type { ClassicModelStack as LocalModelStack } from '@goodvibes-jev/engine/platform/platform/routing';
import type { ClassicModelStack as LocalModelStack } from '@goodvibes-jev/engine/platform/platform/routing';

function localReadingOptions(options: ModelReadingOptions): ModelReadingOptions {
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const assertOptions = () => { signal?.throwIfAborted(); };
  const assertCurrent = () => {
    assertOptions();
    assertProjectionCurrent(callerCurrent);
    assertOptions();
  };
  assertCurrent();
  // Retained checks survive source receipt release, so only native options are retained.
  options.retainCurrent?.(assertOptions);
  return { ...options, assertCurrent };
}

function retain(authority: ReturnType<typeof captureJudgmentPort>, current: ModelReadingOptions, site: string): void {
  assertProjectionCurrent(current.assertCurrent);
  if (isClassicOperation()) return;
  const restriction = authority.consumeObservation();
  const semanticCurrent = () => { if (!isClassicOperation()) restriction.assertCurrent(); };
  current.retainCurrent?.(semanticCurrent, site);
  semanticCurrent();
}

function localModelDecision<T>(options: ModelReadingOptions, decision: () => Promise<T>, classic: () => T): Promise<T> {
  const owned = localReadingOptions(options);
  return decisionOrClassic(decision, () => {
    assertProjectionCurrent(owned.assertCurrent);
    const result = classic();
    assertProjectionCurrent(owned.assertCurrent);
    return result;
  });
}

export async function readLocalModelStack(value: string, evidence: unknown, options: ModelReadingOptions): Promise<LocalModelStack | null> {
  return localModelDecision<LocalModelStack | null>(options, async () => {
    const reading = localReadingOptions(options);
    return withModelReadingSource({ evidence_kind: 'registry', registry_text: value, record: evidence }, reading, async (captured, current) => {
      const site = 'agent.local-model.registry-identity';
      const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
      try {
        const run = await localServerIdentity.route(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
        authority.assertCurrent(); run.recordAction('read-only local registry server identity');
        if (run.reading.outcome !== 'act') return null;
        switch (run.route) {
          case 'ollama': case 'vllm': case 'openai-compatible': return run.route;
          case 'llamacpp': return 'llama.cpp';
          case 'lm-studio': case 'localai': case 'tgi': return 'openai-compatible';
          default: return null;
        }
      } finally { retain(authority, current, site); }
    });
  }, () => declaredClassicModelStack(value));
}

export async function readLocalServingBoolean(value: unknown, parameter: string, record: unknown, options: ModelReadingOptions): Promise<boolean | null> {
  return localModelDecision<boolean | null>(options, async () => {
    const readingOptions = localReadingOptions(options);
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    if (typeof value !== 'string') return null;
    return withModelReadingSource({ value, parameter, record, tool: 'host-published local model serving diagnostics',
      description: 'Whether the named capability is currently supported or enabled, according to the complete publisher record.' }, readingOptions, async (captured, current) => {
      const site = 'agent.local-model.capability-boolean';
      const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
      try {
        const run = await booleanValue.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
        authority.assertCurrent(); run.recordAction('read-only local serving capability');
        const reading = run.readings.boolean_value;
        return reading.outcome === 'act' && reading.choice !== 'neither' ? reading.choice === 'true' : null;
      } finally { retain(authority, current, site); }
    });
  }, () => declaredClassicBoolean(value));
}

export async function readLocalServingStatus(value: string, record: unknown, options: ModelReadingOptions): Promise<LocalModelServerServingDiagnostics['status']> {
  return localModelDecision<LocalModelServerServingDiagnostics['status']>(options, async () => {
    const reading = localReadingOptions(options);
    return withModelReadingSource({ value, record }, reading, async (captured, current) => {
      const site = 'agent.local-model.serving-status';
      const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
      try {
        const run = await localServingStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
        authority.assertCurrent(); run.recordAction('read-only local serving posture');
        return run.readings.status.outcome === 'act' ? run.readings.status.choice : 'unknown';
      } finally { retain(authority, current, site); }
    });
  }, () => declaredClassicServingStatus(value));
}

export async function readLocalResourcePressure(value: string, record: unknown, options: ModelReadingOptions): Promise<LocalModelServerServingDiagnostics['resourcePressure']> {
  return localModelDecision<LocalModelServerServingDiagnostics['resourcePressure']>(options, async () => {
    const reading = localReadingOptions(options);
    return withModelReadingSource({ value, record }, reading, async (captured, current) => {
      const site = 'agent.local-model.resource-pressure';
      const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
      try {
        const run = await localResourcePressure.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
        authority.assertCurrent(); run.recordAction('read-only local resource pressure');
        return run.readings.pressure.outcome === 'act' ? run.readings.pressure.choice : 'unknown';
      } finally { retain(authority, current, site); }
    });
  }, () => declaredClassicResourcePressure(value));
}

export async function readLocalServingSchemaStatus(value: string, record: unknown, options: ModelReadingOptions): Promise<boolean | null> {
  return localModelDecision<boolean | null>(options, async () => {
    const reading = localReadingOptions(options);
    return withModelReadingSource({ value, record }, reading, async (captured, current) => {
      const site = 'agent.local-model.schema-status';
      const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
      try {
        const run = await localServingSchemaStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
        authority.assertCurrent(); run.recordAction('read-only publisher schema claim');
        return run.readings.certified.outcome === 'act' && run.readings.certified.verdict === 'yes';
      } finally { retain(authority, current, site); }
    });
  }, () => null);
}

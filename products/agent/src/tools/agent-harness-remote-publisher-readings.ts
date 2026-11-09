import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { remotePublisherOutcomeKind, remotePublisherSchemaStatus } from '@goodvibes-jev/engine/platform/platform/routing';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';

/** Missing interpretation is distinct from a negative schema verdict or an "other" operation. */
async function withRemotePublisherReading<T>(source: unknown, options: CatalogRankingOptions, site: string,
  read: (captured: unknown, authority: JudgmentPortCapture) => Promise<T>): Promise<T | 'unassessed'> {
  return withConfiguredDecisionModelPolicy(() => withModelReadingSource(source, options, async (captured, current) => {
    return decisionOrClassic<T | 'unassessed'>(async () => {
      const authority = captureJudgmentPort(site, {
        signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult,
      });
      try {
        const result = await read(captured, authority);
        authority.assertCurrent(); return result;
      } finally {
        const restriction = authority.consumeObservation();
        const retained = () => {
          current.signal?.throwIfAborted();
          authority.signal.throwIfAborted();
          if (!isClassicOperation()) restriction.assertCurrent();
        };
        current.retainCurrent?.(retained, site);
        retained();
      }
    }, () => { current.assertCurrent?.(); return 'unassessed' as const; },
    () => { current.signal?.throwIfAborted(); current.assertCurrent?.(); return true; });
  }));
}

export async function readRemotePublisherSchemaStatus(source: unknown, options: CatalogRankingOptions): Promise<'certified' | 'legacy' | 'unassessed'> {
  const site = 'agent.remote-publisher.schema-status';
  return withRemotePublisherReading<'certified' | 'legacy'>(source, options, site, async (captured, authority) => {
    const run = await remotePublisherSchemaStatus.run(authority.port, personalOpsEntry(captured), {
      site, signal: authority.signal, beforeAttempt: authority.assertCurrent,
    });
    authority.assertCurrent();
    run.recordAction('read-only remote publisher schema-status interpretation');
    const reading = run.readings.certified_schema;
    if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new ToolInputProjectionError('held');
    return reading.verdict === 'yes' ? 'certified' : 'legacy';
  });
}

export async function readRemotePublisherOutcomeKind(source: unknown, options: CatalogRankingOptions): Promise<'capture' | 'export' | 'closeout' | 'artifact' | 'other' | 'unassessed'> {
  const site = 'agent.remote-publisher.outcome-kind';
  return withRemotePublisherReading<'capture' | 'export' | 'closeout' | 'artifact' | 'other'>(source, options, site, async (captured, authority) => {
    const run = await remotePublisherOutcomeKind.run(authority.port, personalOpsEntry(captured), {
      site, signal: authority.signal, beforeAttempt: authority.assertCurrent,
    });
    authority.assertCurrent();
    run.recordAction('read-only remote publisher outcome operation interpretation');
    if (run.readings.outcome_kind.outcome !== 'act') throw new ToolInputProjectionError('held');
    return run.readings.outcome_kind.choice;
  });
}

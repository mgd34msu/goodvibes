import { classicPersonalOpsReceiptStatus, decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { personalOpsReceiptStatus } from '@goodvibes-jev/engine/platform/platform/routing';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';

/** Only the pure interpretation phase is replaceable. The complete original protected source remains owned. */
async function withPersonalOpsReading<S, T>(source: S, options: CatalogRankingOptions, site: string,
  read: (captured: S, authority: JudgmentPortCapture) => Promise<T>, classic: (captured: S) => T): Promise<T> {
  return withConfiguredDecisionModelPolicy(() => withModelReadingSource(source, options, async (captured, current) => {
    const assertCurrent = () => { current.signal?.throwIfAborted(); current.assertCurrent?.(); };
    return decisionOrClassic(async () => {
      const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent, prepareResultCapture: prepareJudgmentResult });
      try { const result = await read(captured, authority); authority.assertCurrent(); return result; }
      finally {
        const observation = authority.consumeObservation();
        const retained = () => { current.signal?.throwIfAborted(); authority.signal?.throwIfAborted();
          if (!isClassicOperation()) observation.assertCurrent(); };
        current.retainCurrent?.(retained, site); retained();
      }
    }, () => { assertCurrent(); return classic(captured); }, () => { assertCurrent(); return true; });
  }));
}

/** The outcome a saved provider-effect receipt states; read only when the receipt does not state it as an exact field. */
export async function readPersonalOpsReceiptStatus(source: unknown, options: CatalogRankingOptions): Promise<string> {
  const stated = classicPersonalOpsReceiptStatus(source);
  if (stated !== 'unassessed') return stated;
  const site = 'agent.personal-ops.receipt-status';
  return withPersonalOpsReading(source, options, site, async (captured, authority) => {
    const run = await personalOpsReceiptStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only published effect receipt classification');
    if (run.readings.status.outcome !== 'act') throw new ToolInputProjectionError('held');
    return run.readings.status.choice;
  }, captured => classicPersonalOpsReceiptStatus(captured));
}

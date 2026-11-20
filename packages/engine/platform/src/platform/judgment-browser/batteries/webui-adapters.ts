import { declaredProviderCatalogId } from '@goodvibes/engine/contracts';
import type { BatteryRun, Outcome, Reading } from '@goodvibes/judgment/decisions';
import { BrowserJudgmentError, type BrowserJudgmentInputMap } from '@goodvibes/engine/daemon-api';
import type { BrowserJudgmentBattery, BrowserJudgmentProjection } from '../types.js';
import { catalogProviderMatchBattery, WEBUI_BATTERY_QUESTIONS } from './webui-specs.js';
import { snapshotWebuiCredentialNames } from './webui-readers.js';

const inputHeld = (): never => { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); };
const checkAbort = (signal: AbortSignal): void => { if (signal.aborted) throw new BrowserJudgmentError('JUDGMENT_ABORTED'); };
function preflight<T>(capture: () => T): T {
  try { return capture(); } catch { return inputHeld(); }
}
function held(readings: Readonly<Record<string, Reading>>, compoundOutcome?: Exclude<Outcome, 'act'>): Extract<BrowserJudgmentProjection<never>, { status: 'held' }> {
  return { status: 'held', reason: 'uncertain', readings, ...(compoundOutcome === undefined ? {} : { compoundOutcome }) };
}
/**
 * The retained decision names what was actually sent. Adapters call this from `record`, which the
 * service runs only after the projection passed validation and the final authorization check.
 */
function recordProjection(runs: readonly { recordAction(action: string): void }[], projection: BrowserJudgmentProjection<unknown>): void {
  const action = projection.status === 'settled' ? 'ready' : projection.compoundOutcome !== undefined ? 'conflicting-evidence' : 'unsettled';
  for (const run of runs) run.recordAction(action);
}
const unsettled = (readings: Readonly<Record<string, Reading>>): boolean => Object.values(readings).some((reading) => reading.outcome !== 'act');

type CatalogProviderRun = readonly BatteryRun<typeof catalogProviderMatchBattery.items>[];
export function createWebuiCatalogProviderAdapter(resolve: BrowserJudgmentBattery<'webui.models.catalog-provider-match', BrowserJudgmentInputMap['webui.models.catalog-provider-match'], CatalogProviderRun>['resolve']): BrowserJudgmentBattery<'webui.models.catalog-provider-match', BrowserJudgmentInputMap['webui.models.catalog-provider-match'], CatalogProviderRun> {
  return {
    id: 'webui.models.catalog-provider-match', version: 1, maxCalls: 64, questions: WEBUI_BATTERY_QUESTIONS['webui.models.catalog-provider-match']!, resolve,
    async run(port, input, { signal }) {
      checkAbort(signal); const source = preflight(() => snapshotWebuiCredentialNames(input));
      if (declaredProviderCatalogId(source.providerId) !== undefined) return inputHeld();
      const runs: BatteryRun<typeof catalogProviderMatchBattery.items>[] = [];
      // One browser request, bounded server fan-out. The service owns shared budgets and retries.
      let next = 0; let failure: unknown;
      await Promise.all(Array.from({ length: Math.min(4, source.keys.length) }, async () => {
        while (next < source.keys.length && !signal.aborted && failure === undefined) {
          const index = next++;
          try { runs[index] = await catalogProviderMatchBattery.run(port, { providerId: source.providerId, key: source.keys[index]! }, { signal, site: 'webui.models.catalog-provider-match' }); }
          catch (error) { failure = error; }
        }
      }));
      checkAbort(signal); if (failure !== undefined) throw failure; return runs;
    },
    project(runs) {
      const readings = Object.fromEntries(runs.map((run, index) => [`key_${index}`, run.readings.matches]));
      if (unsettled(readings)) return held(readings);
      return { status: 'settled', value: { matches: runs.map(run => run.readings.matches.verdict === 'yes') }, readings };
    },
    record(runs, projection) { recordProjection(runs, projection); },
  };
}

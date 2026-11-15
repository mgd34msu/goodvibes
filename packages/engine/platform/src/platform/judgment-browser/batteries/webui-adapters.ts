import { declaredProviderCatalogId } from '@goodvibes-jev/engine/contracts';
import type { BatteryRun, Outcome, Reading, YesNoReading } from '@goodvibes-jev/judgment/decisions';
import { BrowserJudgmentError, type BrowserJudgmentInputMap } from '@goodvibes-jev/engine/daemon-api';
import type { BrowserJudgmentBattery, BrowserJudgmentProjection } from '../types.js';
import { catalogProviderMatchBattery, daemonRefusalBattery, WEBUI_BATTERY_QUESTIONS } from './webui-specs.js';
import { readStructuredDaemonRefusal, snapshotWebuiDaemonRefusal, snapshotWebuiCredentialNames } from './webui-readers.js';
import { REFUSAL_ITEMS, type DaemonRefusalValue, type ResolvedDaemonRefusal } from './webui-types.js';

const ERRORS = 'webui.errors.daemon-refusal';
const inputHeld = (): never => { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); };
const referenceHeld = (): never => { throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); };
const invalid = (): never => { throw new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE'); };
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
const hasHttpStatus = (source: ResolvedDaemonRefusal): source is ResolvedDaemonRefusal & { readonly status: number } => source.status !== undefined && Number.isInteger(source.status) && source.status >= 100 && source.status <= 599;

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

/** Server-only intermediate evidence consumed by the refusal descriptor. */
export interface WebuiDaemonRefusalRun {
  readonly source: ResolvedDaemonRefusal & { readonly status: number };
  readonly run: BatteryRun<typeof daemonRefusalBattery.items>;
}

/** Genuine unresolved failure refs only; machine codes are handled before the endpoint. */
export const webuiDaemonRefusalAdapter: BrowserJudgmentBattery<'webui.errors.daemon-refusal', ResolvedDaemonRefusal, WebuiDaemonRefusalRun> = {
  id: ERRORS, version: 1, maxCalls: 1, questions: WEBUI_BATTERY_QUESTIONS[ERRORS]!,
  async resolve(input, context) {
    checkAbort(context.signal);
    const resolved = context.references.resolve(input.errorRef, context.currentPrincipal, ERRORS, snapshotWebuiDaemonRefusal);
    if (readStructuredDaemonRefusal(resolved.state) !== undefined || !resolved.state.message.trim()) return inputHeld();
    if (!hasHttpStatus(resolved.state)) return referenceHeld();
    return resolved;
  },
  async run(port, raw, { signal }) {
    checkAbort(signal);
    const source = preflight(() => snapshotWebuiDaemonRefusal(raw));
    if (readStructuredDaemonRefusal(source) !== undefined || !source.message.trim()) return inputHeld();
    if (!hasHttpStatus(source)) return inputHeld();
    const only = REFUSAL_ITEMS.filter((item) => item !== 'method_unknown' || source.status === 404);
    const run = await daemonRefusalBattery.run(port, { ...source }, { signal, only, site: ERRORS });
    checkAbort(signal);
    return { source, run };
  },
  project({ source, run }) {
    const names = REFUSAL_ITEMS.filter((item) => item !== 'method_unknown' || source.status === 404);
    const readings: Record<string, YesNoReading> = Object.fromEntries(names.map((name) => [name, run.readings[name]]));
    if (names.some((name) => !readings[name])) return invalid();
    const basis = source.status === 404 ? {} : { structuralBasis: { method_unknown: 'http-status-not-404' as const } };
    if (unsettled(readings)) return { ...held(readings), ...basis };
    const value: DaemonRefusalValue = {
      session_not_found: run.readings.session_not_found.verdict === 'yes',
      session_closed: run.readings.session_closed.verdict === 'yes',
      session_active: run.readings.session_active.verdict === 'yes',
      session_not_local: run.readings.session_not_local.verdict === 'yes',
      method_unknown: source.status === 404 && run.readings.method_unknown.verdict === 'yes',
    };
    const conflict = (value.session_not_found && (value.session_closed || value.session_active || value.session_not_local))
      || (value.session_closed && value.session_active)
      || (value.method_unknown && (value.session_not_found || value.session_closed || value.session_active || value.session_not_local));
    if (conflict) return { ...held(readings, 'escalate'), ...basis };
    return { status: 'settled', value, readings, ...basis };
  },
  record({ run }, projection) { recordProjection([run], projection); },
};

import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { captureJudgmentPort, JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { modelReasonTheme, MODEL_REASON_THEME_LABELS, type ModelReasonTheme } from '@goodvibes-jev/engine/platform/platform/routing';
import { assertProjectionCurrent, ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { JudgmentError, matchesJudgmentModel } from '@goodvibes-jev/judgment';
import { withModelReadingSource, type ModelReadingOptions } from './model-reading.js';
import type { LoadedComparisonJudgment } from './model-compare-types.js';

/** The themes read for one judgment, stored on the judgment artifact when it is saved. */
export interface StoredReasonThemes {
  readonly battery: string;
  readonly version: number;
  readonly themes: readonly ModelReasonTheme[];
  readonly model: string;
  readonly decisionId?: string | undefined;
}

export type ComparisonThemeReading =
  | { readonly status: 'held'; readonly reason: string }
  | { readonly status: 'not-evaluated'; readonly provenance: 'classic' }
  | { readonly status: 'settled'; readonly themes: readonly ModelReasonTheme[]; readonly stored: StoredReasonThemes };

/** A judgment as loaded from its artifact, with the themes stored on it when they were read at save. */
export type JudgmentWithThemes = LoadedComparisonJudgment & { readonly reasonThemes?: StoredReasonThemes | undefined };

/** What a theme reading reads: the chosen blind label and the author's own reasons and notes. */
export type ThemeSource = Pick<LoadedComparisonJudgment, 'winnerBlindId' | 'reasons' | 'notes'>;

const THEME_NAMES = Object.keys(MODEL_REASON_THEME_LABELS) as ModelReasonTheme[];
const NOT_EVALUATED: ComparisonThemeReading = { status: 'not-evaluated', provenance: 'classic' };

/** Stored themes from a judgment artifact's payload, or undefined when absent or malformed. */
export function parseStoredReasonThemes(value: unknown): StoredReasonThemes | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const themes = record.themes;
  if (typeof record.battery !== 'string' || typeof record.version !== 'number' || typeof record.model !== 'string'
    || !Array.isArray(themes) || !themes.every((theme): theme is ModelReasonTheme => (THEME_NAMES as readonly unknown[]).includes(theme))) return undefined;
  return {
    battery: record.battery, version: record.version, themes, model: record.model,
    ...(typeof record.decisionId === 'string' ? { decisionId: record.decisionId } : {}),
  };
}

/** The themes stored on a judgment when the current version of the reading produced them. */
export function currentStoredThemes(judgment: JudgmentWithThemes): StoredReasonThemes | undefined {
  const stored = judgment.reasonThemes;
  return stored && stored.battery === modelReasonTheme.name && stored.version === modelReasonTheme.version ? stored : undefined;
}

/** Settled readings per decision-port installation, keyed by the text read, so a second synthesis asks nothing. */
let settledReadings = new WeakMap<object, Map<string, ComparisonThemeReading>>();
const SETTLED_LIMIT = 512;

/** Forget every remembered theme reading (a test seam and a decision-model change both use a fresh installation). */
export function forgetComparisonReasonThemes(): void {
  settledReadings = new WeakMap();
}

/**
 * One reading of which themes the author gave as reasons, from the reasons and
 * notes only. The text is screened by the source owner before the decision
 * model sees it; with no source owner nothing is sent. Under Classic nothing is
 * asked. A hold says why.
 */
export async function readComparisonReasonThemes(judgment: ThemeSource, options: ModelReadingOptions): Promise<ComparisonThemeReading> {
  return withConfiguredDecisionModelPolicy(() => readOwnedComparisonReasonThemes(judgment, options));
}

async function readOwnedComparisonReasonThemes(judgment: ThemeSource, options: ModelReadingOptions): Promise<ComparisonThemeReading> {
  options.signal?.throwIfAborted(); assertProjectionCurrent(options.assertCurrent);
  if (isClassicOperation()) return NOT_EVALUATED;
  if (!options.sourceOwner) return { status: 'held', reason: 'this runtime has no source screening, so the reasons were not sent to the decision model' };
  const state = { judgment: { winner: judgment.winnerBlindId, reasons: judgment.reasons, notes: judgment.notes } };
  const key = JSON.stringify([modelReasonTheme.version, state]);
  try {
    return await withModelReadingSource(state, options, async (screened, scoped) => decisionOrClassic<ComparisonThemeReading>(async () => {
      const port = captureJudgmentPort(modelReasonTheme.name, { signal: scoped.signal, assertCurrent: scoped.assertCurrent, prepareResultCapture: prepareJudgmentResult });
      let remembered = settledReadings.get(port.identity);
      const known = remembered?.get(key);
      if (known) return known;
      const run = await modelReasonTheme.run(port.port, screened, { site: modelReasonTheme.name, signal: port.signal });
      port.assertCurrent();
      if (!matchesJudgmentModel(port.port.model, run.result.model) || run.result.requestedModel !== port.port.model) {
        return { status: 'held', reason: `the reading came from ${run.result.model}, not the configured decision model` };
      }
      const unsure = THEME_NAMES.filter(name => run.readings[name].outcome !== 'act');
      const themes = THEME_NAMES.filter(name => run.readings[name].verdict === 'yes');
      run.recordAction(unsure.length ? 'held preference theme classification'
        : themes.length ? `classified preference themes: ${themes.join(', ')}` : 'uncategorized affirmative preference');
      port.assertCurrent();
      if (unsure.length) return { status: 'held', reason: `the decision model was unsure whether the reasons state ${unsure.map(name => MODEL_REASON_THEME_LABELS[name].toLowerCase()).join(', ')}` };
      const reading: ComparisonThemeReading = { status: 'settled', themes, stored: {
        battery: modelReasonTheme.name, version: modelReasonTheme.version, themes, model: run.result.model,
        ...(run.result.decisionId === undefined ? {} : { decisionId: run.result.decisionId }),
      } };
      if (!remembered) { remembered = new Map(); settledReadings.set(port.identity, remembered); }
      if (remembered.size >= SETTLED_LIMIT) remembered.delete(remembered.keys().next().value!);
      remembered.set(key, reading);
      return reading;
    }, () => NOT_EVALUATED));
  } catch (error) {
    options.signal?.throwIfAborted(); assertProjectionCurrent(options.assertCurrent);
    // A sibling reading found the decision model unavailable and switched this operation to Classic.
    if (isClassicOperation()) return NOT_EVALUATED;
    return { status: 'held', reason: holdReason(error) };
  }
}

function holdReason(error: unknown): string {
  if (error instanceof ToolInputProjectionError) return 'source screening did not clear the reasons for the decision model';
  if (error instanceof JudgmentAuthorityRetiredError) return 'the decision model changed while it was reading';
  if (error instanceof JudgmentError) return `the decision model request failed (${error.kind})`;
  return 'the reading failed before it settled';
}

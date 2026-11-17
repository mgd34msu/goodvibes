import { toJson, type DecisionContext, type EntryType, type JudgmentPort, type JudgmentRequest, type JudgmentResult, type Questions } from '../port/types.ts';
import type { PatternHeader } from './decision.ts';

export type { PatternHeader } from './decision.ts';

/** The patterns and compounds that issue calls, as the decision log names them. */
export type PatternName =
  | 'battery'
  | 'dispatch'
  | 'judge'
  | 'rerank'
  | 'existence'
  | 'reply'
  | 'alignment'
  | 'fidelity'
  | 'policy'
  | 'select'
  | 'date-parts'
  | 'count'
  | 'coarsen'
  | 'ladder'
  | 'call'
  | 'extraction'
  | 'structure.stitch'
  | 'structure.classify'
  | 'rank-recheck.wide'
  | 'rank-recheck.recheck'
  | 'hierarchy'
  | 'composite'
  | 'fan-out'
  | 'features'
  | 'compound-split';

export interface CallOptions {
  readonly beforeAttempt?: () => void;
  readonly beforeAsyncAttempt?: () => void | Promise<void>;
  readonly onRetry?: (progress: import('../port/types.ts').JudgmentRetryProgress) => void;
  readonly signal?: AbortSignal;
  /** The decision site, recorded in the decision log. */
  readonly site?: string;
  /** The calibration fixture the call runs, recorded in the decision log. */
  readonly fixture?: string;
}


/** A call's decision log entry, when the port keeps a log. */
type DecisionIdOf = JudgmentResult<Questions>['decisionId'];

/** The attribution a call carries into the decision log. */
export function contextFor(header: PatternHeader, pattern: PatternName, options: Pick<CallOptions, 'site' | 'fixture'> & Pick<DecisionContext, 'commitments'> = {}): DecisionContext {
  const { site, fixture, commitments } = options;
  return {
    battery: header.name,
    batteryVersion: header.version,
    pattern,
    ...(site === undefined ? {} : { site }),
    ...(fixture === undefined ? {} : { fixture }),
    ...(commitments === undefined ? {} : { commitments }),
  };
}

/** A decision's shared evaluator rules and the questions they do not govern (a battery's `context` and `withoutContext`). */
export interface SharedContextSource {
  readonly context?: string | undefined;
  readonly withoutContext?: readonly string[] | undefined;
}

/**
 * The shared context a request asking `asked` of a decision carries: its
 * rules once for the request, with the asked questions they do not govern
 * named; nothing when it has no rules or they govern none of the asked
 * questions.
 */
export function sharedContextFor(source: SharedContextSource, asked: readonly string[]): Pick<JudgmentRequest<Questions>, 'sharedContext' | 'withoutSharedContext'> {
  if (!source.context) return {};
  const exempt = new Set(source.withoutContext ?? []);
  const without = asked.filter(name => exempt.has(name));
  if (without.length === asked.length) return {};
  return without.length === 0 ? { sharedContext: source.context } : { sharedContext: source.context, withoutSharedContext: without };
}

/**
 * Asks on behalf of a named decision, attributing the call in the decision
 * log. A decision with a `context` (a battery's shared evaluator rules) sends
 * it once, as the request's shared context, naming the asked questions it
 * does not govern.
 */
export function askAs<const Q extends Questions>(
  port: JudgmentPort,
  header: PatternHeader & SharedContextSource,
  pattern: PatternName,
  state: EntryType,
  questions: Q,
  options: CallOptions & Pick<DecisionContext, 'commitments'> = {},
): Promise<JudgmentResult<Q>> {
  return port.ask({
    state,
    questions,
    ...sharedContextFor(header, Object.keys(questions)),
    ...(header.model === undefined ? {} : { model: header.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.beforeAttempt === undefined ? {} : { beforeAttempt: options.beforeAttempt }),
    ...(options.beforeAsyncAttempt === undefined ? {} : { beforeAsyncAttempt: options.beforeAsyncAttempt }),
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
    context: contextFor(header, pattern, options),
  });
}

/**
 * Attaches a decision's conclusions to its call's decision log entry. The
 * decision log's recorder never throws here: the work is done, so a note it
 * cannot write is counted and reported by the composition instead.
 */
export function recordReadings<C extends object>(port: JudgmentPort, result: { readonly decisionId?: DecisionIdOf }, conclusions: C): void {
  const { decisionId } = result;
  if (decisionId !== undefined) port.recorder?.recordReadings(decisionId, toJson(conclusions));
}

/** Records what code did with a decision; a no-op when the port keeps no log. */
export function recordAction(port: JudgmentPort, decisionId: DecisionIdOf, action: string): void {
  if (decisionId !== undefined) port.recorder?.recordAction(decisionId, action);
}

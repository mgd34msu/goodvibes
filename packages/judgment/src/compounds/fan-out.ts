import type { AnyReading, Battery, BatteryItems, ReadingFor } from '../batteries/battery.ts';
import { readItem } from '../batteries/battery.ts';
import { recordAction, recordReadings, type CallOptions } from '../batteries/asking.ts';
import type { EntryType, JudgmentPort, JudgmentResult, Question, Questions } from '../port/types.ts';
import { prefixInstructions } from '../port/shared-context.ts';

type WireAnswers = JudgmentResult<Questions>['answers'];
type PartReadings = Readonly<Record<string, Readonly<Record<string, AnyReading>>>>;

type Parts = Readonly<Record<string, Battery<BatteryItems>>>;
type Selection<P extends Parts> = { readonly [K in keyof P]?: readonly (keyof P[K]['items'] & string)[] };

type SelectedKeys<Items, Selected> = Selected extends readonly (infer Key)[] ? Extract<keyof Items, Key> : keyof Items;

export type FannedReadings<P extends Parts, Only extends Selection<P> = {}> = {
  readonly [K in keyof P]: P[K] extends Battery<infer Items>
    ? { readonly [I in SelectedKeys<Items, K extends keyof Only ? Only[K] : undefined>]: ReadingFor<Items[I]> }
    : never;
};

export interface FannedOut<P extends Parts, Only extends Selection<P> = {}> {
  /** Shared request provenance, including requested alias and resolved model. */
  readonly result: JudgmentResult<Questions>;
  readonly readings: FannedReadings<P, Only>;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

/** A battery's question inside a fanned-out request: `<part>__<question>`. */
const SEPARATOR = '__';
const questionKey = (part: string, item: string): string => `${part}${SEPARATOR}${item}`;

/** The one model every part is tuned on; batteries on different models cannot share a request. */
function sharedModel(defaultModel: string, parts: Parts): string {
  const models = new Set(Object.values(parts).map((battery) => battery.model ?? defaultModel));
  if (models.size > 1) throw new RangeError(`fan-out batteries are tuned on different models (${[...models].join(', ')}); run them apart`);
  return [...models][0]!;
}

function selectedItems(parts: Parts, only: Readonly<Record<string, readonly string[] | undefined>> = {}): Readonly<Record<string, BatteryItems>> {
  for (const part of Object.keys(only)) {
    if (!Object.hasOwn(parts, part)) throw new RangeError(`fan-out has no part "${part}"`);
  }
  return Object.fromEntries(Object.entries(parts).map(([part, battery]) => {
    const selected = only[part] ?? Object.keys(battery.items);
    if (selected.length === 0 || new Set(selected).size !== selected.length) throw new RangeError(`fan-out part "${part}" needs unique selected questions`);
    return [part, Object.fromEntries(selected.map(item => {
      const spec = battery.items[item];
      if (spec === undefined) throw new RangeError(`fan-out part "${part}" has no question "${item}"`);
      return [item, spec];
    }))];
  }));
}

/** Whether a part's evaluator rules govern one of its questions (it has rules, and the item is not in its `withoutContext`). */
function governed(battery: Battery<BatteryItems>, item: string): boolean {
  return !!battery.context && !(battery.withoutContext ?? []).includes(item);
}

/**
 * The one set of rules every governed selected question shares, sent once as
 * the request's shared context; undefined when no selected question is
 * governed, or when the parts' rules differ (then each part's own rules go
 * ahead of only its governed questions).
 */
function commonContext(parts: Parts, selected: Readonly<Record<string, BatteryItems>>): string | undefined {
  const contexts = new Set(Object.entries(selected).flatMap(([part, items]) => {
    const battery = parts[part]!;
    return Object.keys(items).some(item => governed(battery, item)) ? [battery.context!] : [];
  }));
  return contexts.size === 1 ? [...contexts][0] : undefined;
}

/** The merged questions, and those the shared context does not govern (a part without rules, an item its battery leaves out). */
function mergedQuestions(parts: Parts, selected: Readonly<Record<string, BatteryItems>>, shared: string | undefined): { readonly questions: Questions; readonly without: readonly string[] } {
  const questions: Record<string, Question> = {};
  const without: string[] = [];
  for (const [part, items] of Object.entries(selected)) {
    if (part.includes(SEPARATOR)) throw new RangeError(`fan-out part "${part}" may not contain "${SEPARATOR}"`);
    const battery = parts[part]!;
    for (const [item, spec] of Object.entries(items)) {
      const key = questionKey(part, item);
      if (!governed(battery, item)) {
        questions[key] = spec.question;
        if (shared !== undefined) without.push(key);
      } else questions[key] = shared === undefined ? prefixInstructions(spec.question, battery.context!) : spec.question;
    }
  }
  return { questions, without };
}

function readParts(parts: Readonly<Record<string, BatteryItems>>, answers: WireAnswers): PartReadings {
  return Object.fromEntries(
    Object.entries(parts).map(([part, items]) => [
      part,
      Object.fromEntries(Object.entries(items).map(([item, spec]) => [item, readItem(spec, answers[questionKey(part, item)])])),
    ]),
  );
}

/**
 * Speculative fan-out across batteries: every question of every battery about
 * the same state rides one request, and each battery reads its own answers
 * through its own bands. Questions are independent, so combining them changes
 * no answer and saves a round trip per battery (the parallel questions
 * cookbook). Code then decides which readings matter on its path. Each
 * battery stays calibrated on its own; the fan-out adds no judgment.
 */
export async function fanOut<const P extends Parts, const Only extends Selection<P> = {}>(
  port: JudgmentPort,
  state: EntryType,
  parts: P,
  options: CallOptions & { readonly label?: string; readonly only?: Only } = {},
): Promise<FannedOut<P, Only>> {
  options.signal?.throwIfAborted();
  if (Object.keys(parts).length === 0) throw new RangeError('fan-out needs at least one battery');
  const defaultModel = port.model;
  const model = sharedModel(defaultModel, parts);
  const selected = selectedItems(parts, options.only);
  const shared = commonContext(parts, selected);
  const merged = mergedQuestions(parts, selected, shared);
  const batteries = Object.entries(parts).map(([part, battery]) => ({
    part, name: battery.name, version: battery.version, model: battery.model ?? defaultModel,
    questions: Object.keys(selected[part]!),
  }));
  const result = await port.ask({
    state,
    questions: merged.questions,
    ...(shared === undefined ? {} : { sharedContext: shared }),
    ...(merged.without.length === 0 ? {} : { withoutSharedContext: merged.without }),
    ...(model === defaultModel ? {} : { model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.beforeAttempt === undefined ? {} : { beforeAttempt: options.beforeAttempt }),
    ...(options.beforeAsyncAttempt === undefined ? {} : { beforeAsyncAttempt: options.beforeAsyncAttempt }),
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
    context: {
      battery: options.label ?? Object.values(parts).map((battery) => battery.name).join('+'),
      pattern: 'fan-out',
      ...(options.site === undefined ? {} : { site: options.site }),
      ...(options.fixture === undefined ? {} : { fixture: options.fixture }),
    },
  });
  options.signal?.throwIfAborted();
  const readings = readParts(selected, result.answers);
  recordReadings(port, result, { readings, batteries });
  return { result, readings: readings as FannedReadings<P, Only>, decisionId: result.decisionId, recordAction: (action) => recordAction(port, result.decisionId, action) };
}

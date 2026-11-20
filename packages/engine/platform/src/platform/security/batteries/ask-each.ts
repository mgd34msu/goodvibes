/**
 * Questions of a calibrated battery asked about several subjects in one
 * request. Question `<item>_<i>` carries the battery's own instructions for
 * that item and subject `i` (under `subjectKey`); `state` holds what the
 * subjects share. A request with one subject is the battery's own calibrated
 * shape: its item keys, over the subject (`subjectKey` `subject`) or the
 * shared state with the subject under `subjectKey`. The fixtures and the calibration are the battery's own, as
 * for a single subject: only the number of round trips changes. Subjects are
 * split across more requests only past `perRequest` subjects or `charBudget`
 * characters of subject text.
 */
import {
  askAs, noul, readYesNo, recordReadings, toJson,
  type Battery, type BatteryItems, type CallOptions, type EntryType, type JudgmentPort, type JudgmentResult,
  type NoulQuestion, type NoulResponse, type Questions, type YesNoItem, type YesNoReading,
} from '@goodvibes/judgment';

export interface AskEachOptions extends CallOptions {
  /** Most subjects in one request. */
  readonly perRequest?: number | undefined;
  /** Most characters of subject text in one request. */
  readonly charBudget?: number | undefined;
  /** The name the subject carries inside each question, as the battery's instructions call it. Default `subject`. */
  readonly subjectKey?: string | undefined;
  /** Checks one request's result (its model, say) before it is read; a throw refuses the whole call. */
  readonly answeredBy?: ((result: JudgmentResult<Questions>) => void) | undefined;
}

export interface AskEachResult<Item extends string> {
  /** One reading per subject, in the order given, by item. */
  readonly readings: readonly Readonly<Record<Item, YesNoReading>>[];
  /** The decision-log ids of the requests made, in order. */
  readonly decisionIds: readonly (string | undefined)[];
}

/**
 * The request for several subjects of one battery, attributed to that battery
 * in the decision log: its fixtures and calibration cover each question.
 */
function defineEachReading<Items extends BatteryItems>(battery: Battery<Items>) {
  return (port: JudgmentPort, state: EntryType, questions: Questions, options: CallOptions) =>
    askAs(port, battery, 'battery', state, questions, options);
}

/** Question key of one item about subject `index`. */
export const eachKey = (item: string, index: number): string => `${item}_${String(index)}`;

export async function askEach<Items extends BatteryItems, const Item extends keyof Items & string>(
  port: JudgmentPort,
  battery: Battery<Items>,
  items: readonly Item[],
  state: EntryType,
  subjects: readonly EntryType[],
  options: AskEachOptions = {},
): Promise<AskEachResult<Item>> {
  const specs = items.map((item) => {
    const spec = battery.items[item];
    if (spec === undefined || spec.kind !== 'yes-no') throw new RangeError(`askEach needs yes/no items, "${item}" is not one`);
    return [item, spec as YesNoItem] as const;
  });
  const { perRequest: perRequestOption, charBudget: charBudgetOption, subjectKey: subjectKeyOption, answeredBy, ...call } = options;
  const perRequest = Math.max(1, perRequestOption ?? 32);
  const charBudget = Math.max(1, charBudgetOption ?? 60_000);
  const subjectKey = subjectKeyOption ?? 'subject';
  const groups: number[][] = [];
  let group: number[] = [], size = 0;
  subjects.forEach((subject, index) => {
    const length = JSON.stringify(subject).length;
    if (group.length > 0 && (group.length >= perRequest || size + length > charBudget)) { groups.push(group); group = []; size = 0; }
    group.push(index); size += length;
  });
  if (group.length > 0) groups.push(group);

  const ask = defineEachReading(battery);
  const readings = new Array<Readonly<Record<Item, YesNoReading>>>(subjects.length);
  const decisionIds: (string | undefined)[] = [];
  // Requests run one after another: a subject list past one request is rare,
  // and the caller's signal ends the rest at once.
  for (const indexes of groups) {
    // One subject is asked exactly as the battery is calibrated: its own
    // question keys over the single-subject state.
    const single = indexes.length === 1;
    const keyOf = (item: string, index: number): string => single ? item : eachKey(item, index);
    const questions: Record<string, NoulQuestion> = {};
    for (const index of indexes) for (const [item, spec] of specs) {
      questions[keyOf(item, index)] = single ? spec.question
        : noul(toJson({ question: spec.question.instructions ?? null, [subjectKey]: subjects[index]! }) as EntryType, spec.question.criteria ?? undefined);
    }
    const subject = subjects[indexes[0]!]!;
    const askedState = !single ? state : subjectKey === 'subject' ? subject
      : toJson({ ...(state as Record<string, unknown>), [subjectKey]: subject }) as EntryType;
    const result = await ask(port, askedState, questions, call);
    answeredBy?.(result as JudgmentResult<Questions>);
    const read: Record<string, YesNoReading> = {};
    for (const index of indexes) for (const [item, spec] of specs) {
      const key = keyOf(item, index);
      read[key] = readYesNo(result.answers[key] as NoulResponse, spec.band);
    }
    recordReadings(port, result, read);
    for (const index of indexes) {
      readings[index] = Object.freeze(Object.fromEntries(specs.map(([item]) => [item, read[keyOf(item, index)]!]))) as Readonly<Record<Item, YesNoReading>>;
    }
    decisionIds.push(result.decisionId);
  }
  return { readings, decisionIds };
}

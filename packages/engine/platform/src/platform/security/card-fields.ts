import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
/**
 * card-fields.ts, recognising a payment field on any page.
 *
 * Lives in security/ rather than in payments/ or browser/ because both need it
 * and neither owns it. The browser's snapshot must suppress a payment field's
 * value whether or not the payment capability is even configured, and the
 * payment capability must classify the same way the snapshot does or the two
 * disagree about what was protected. A shared rule in the layer they both
 * already depend on is the only arrangement where that cannot drift.
 *
 * It is also why `platform/browser/` still imports no product surface: this is
 * foundation, like link validation and the public-suffix list beside it.
 *
 * ── How a field is recognised ──────────────────────────────────────────────
 *
 * There is no registry of merchants here and there must never be one. A
 * control whose `autocomplete` attribute carries one of the payment tokens the
 * HTML standard defines has declared itself a payment field, and that
 * declaration is taken as given. An input whose type cannot hold card material
 * (checkbox, email, search, date, ...) is settled in code. Every other form
 * control is read by Jev (`engine.security.card-field`) from its name, id,
 * placeholder and labels in whatever language the page uses, all the controls
 * of one snapshot in one request. A reading depends only on the control's
 * descriptor, so each decision source remembers it for the life of the
 * process: a control already read on any page, tab or step of a form is
 * settled by a lookup. That reading replaced a list of multilingual name and
 * label regexes. A `select` stays a reading: an expiry month or year is often
 * one.
 *
 * ── Erring toward yes ─────────────────────────────────────────────────────
 *
 * A false positive costs the model the contents of one form field, which it can
 * ask the owner about. A false negative hands it a card number. Those are not
 * comparable, so a control is treated as a payment field unless the reading
 * is a confident no.
 */
import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { checkAnswers, recordAction, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { cardField, type CardFieldView } from './batteries/card-field.js';
import { askEach } from './batteries/ask-each.js';
import { runDecisionOrClassic as decisionOrClassic } from '@goodvibes-jev/engine/errors';

/**
 * Everything about one control the classification may look at.
 *
 * A plain record rather than a DOM element, because the function that walks a
 * page is serialized and evaluated inside the browser and can import nothing.
 * The in-page collector gathers these attributes; the judgement happens in
 * process, where it can be tested against real inputs instead of merely read.
 */
export interface FormControlDescriptor {
  readonly tag: string;
  readonly type: string;
  readonly autocomplete: string;
  readonly name: string;
  readonly id: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly label: string;
}

/**
 * The autofill tokens the HTML standard defines for payment instruments.
 *
 * A checkout that wants a browser to fill it must use these, so this catches
 * every well-behaved payment form without knowing anything about the site.
 */
const CARD_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set([
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
  'cc-additional-name',
  'cc-type',
]);

/** The decision site the card-field reading is logged under. */
export const CARD_FIELD_SITE = 'security.card-field';

/**
 * Input types whose value cannot hold card material: settled in code, no request.
 * `month` is not here: an expiry can be a month input.
 */
const NON_CARD_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox', 'radio', 'file', 'range', 'color', 'date', 'datetime-local', 'week', 'time',
  'email', 'url', 'search', 'submit', 'button', 'reset', 'image', 'hidden',
]);

/**
 * What a snapshot does with one control's value:
 * - `reported`: the value is shown.
 * - `card-field`: a payment field; the value is never reported.
 * - `no-decision-model`: a digit-entry control nobody could read for card
 *   meaning because no decision model is available; the value is withheld and
 *   the element says so.
 */
export type CardFieldDecision = 'reported' | 'card-field' | 'no-decision-model';

/** Readings remembered for one decision source: descriptor key to "is a card field". */
export type CardFieldMemory = Map<string, boolean>;

/** Most readings one decision source remembers; the least recently used is dropped first. */
const MEMORY_LIMIT = 1_024;

const sourceMemories = new WeakMap<object, CardFieldMemory>();

/**
 * The readings remembered for one decision source, keyed by its opaque cache
 * identity (a changed model, endpoint or credential is a new identity, so its
 * readings start empty). The memory lives as long as the identity does.
 */
export function cardFieldMemoryFor(source: object): CardFieldMemory {
  let memory = sourceMemories.get(source);
  if (!memory) { memory = new Map(); sourceMemories.set(source, memory); }
  return memory;
}

interface CardFieldReading {
  /** Explicit absence retains the caller's original missing reader. */
  readonly port: JudgmentPort | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
  /** Readings this decision source already made; a control is asked about once per descriptor. */
  readonly memory?: CardFieldMemory | undefined;
}

/**
 * Decide, for every control of one snapshot, whether its value may be
 * reported. Code settles what it can (elements that carry no value, declared
 * `cc-*` tokens, input types that cannot hold card material, and descriptors
 * already read by this decision source); the rest are asked about in ONE request, one yes/no
 * per control. Erring toward yes: a control is a payment field unless the
 * reading is a confident no.
 */
export async function classifyCardFields(controls: readonly FormControlDescriptor[], reading?: CardFieldReading): Promise<CardFieldDecision[]> {
  const source = reading?.port, signal = reading?.signal, assertion = reading?.assertCurrent, memory = reading?.memory;
  const current = (): void => {
    signal?.throwIfAborted();
    assertSynchronousJudgmentGuard(assertion, () => new Error('The card-field reading owner must be synchronous.'));
    signal?.throwIfAborted();
  };
  current();
  // Every field is coerced rather than trusted. This runs on data that came
  // back from inside a page, where a missing or oddly-typed property is an
  // ordinary occurrence, and a throw here would fail the whole snapshot, which
  // is a far worse outcome than misclassifying one control.
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const decisions: CardFieldDecision[] = new Array<CardFieldDecision>(controls.length).fill('reported');
  const pending = new Map<string, { readonly view: CardFieldView; readonly indexes: number[] }>();
  controls.forEach((control, index) => {
    const tag = text(control?.tag).toLowerCase();
    // Only these elements carry a value a snapshot could report.
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    // `autocomplete="shipping cc-number"` and `section-pay cc-csc` are both legal
    // spellings, so each token is checked rather than the whole attribute.
    const tokens = text(control.autocomplete).toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    if (tokens.some((token) => CARD_AUTOCOMPLETE_TOKENS.has(token))) { decisions[index] = 'card-field'; return; }
    const type = text(control.type).toLowerCase();
    if (tag === 'input' && NON_CARD_INPUT_TYPES.has(type)) return;
    const view: CardFieldView = { tag, type: text(control.type), name: text(control.name), id: text(control.id),
      placeholder: text(control.placeholder), ariaLabel: text(control.ariaLabel), label: text(control.label) };
    const key = JSON.stringify([view.tag, view.type, view.name, view.id, view.placeholder, view.ariaLabel, view.label]);
    const remembered = memory?.get(key);
    if (remembered !== undefined) {
      memory!.delete(key); memory!.set(key, remembered);
      if (remembered) decisions[index] = 'card-field';
      return;
    }
    const entry = pending.get(key);
    if (entry) { entry.indexes.push(index); return; }
    pending.set(key, { view, indexes: [index] });
  });
  if (pending.size === 0) return decisions;

  const entries = [...pending.entries()];
  return decisionOrClassic(async () => {
    current();
    const base = reading === undefined ? judgmentPort(CARD_FIELD_SITE) : source;
    if (!base) throw new JudgmentPortMissingError(CARD_FIELD_SITE);
    const port: JudgmentPort = { ...base, async ask(request) {
      const result = await base.ask({ ...request,
        beforeAttempt: () => { current(); assertSynchronousJudgmentGuard(() => request.beforeAttempt?.()); current(); },
        assertLogCurrent: () => { current(); assertSynchronousJudgmentGuard(() => request.assertLogCurrent?.(), 'retention'); current(); },
      });
      checkAnswers(request.questions, result.answers); return result;
    } };
    const { readings, decisionIds } = await askEach(port, cardField, ['card_field'],
      { controls: 'Each question carries one form control of the same page as its subject.' },
      entries.map(([, entry]) => entry.view as unknown as EntryType),
      { site: CARD_FIELD_SITE, ...(signal === undefined ? {} : { signal }), beforeAttempt: current });
    current();
    let suppressed = 0;
    entries.forEach(([key, entry], position) => {
      const resultReading = readings[position]!.card_field;
      const ordinary = resultReading.verdict === 'no' && resultReading.outcome === 'act';
      if (!ordinary) { suppressed += 1; for (const index of entry.indexes) decisions[index] = 'card-field'; }
      if (memory) {
        memory.delete(key);
        if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
        memory.set(key, !ordinary);
      }
    });
    for (const id of decisionIds) recordAction(port, id, `value suppressed for ${String(suppressed)} of ${String(entries.length)} control(s)`);
    return decisions;
  }, () => {
    current();
    // No semantic assessment: every control code could not settle keeps its
    // value back (an unknown or misspelt input type is a text box to a browser,
    // and a select can be an expiry), and each says why. Only input types that
    // cannot hold card material report their value. Selectors, labels, checked
    // state and owner-authorized actions remain usable.
    for (const [, entry] of entries) for (const index of entry.indexes) decisions[index] = 'no-decision-model';
    return decisions;
  });
}

/** Whether this control's value must not be reported (a payment field, or unread with no decision model). */
export async function isCardFieldDescriptor(control: FormControlDescriptor, reading?: CardFieldReading): Promise<boolean> {
  const [decision] = await classifyCardFields([control], reading);
  return decision !== 'reported';
}

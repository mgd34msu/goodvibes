import type { EntryType, JsonValue, Question, Questions } from './types.ts';

/**
 * How a backend's wire carries a request's shared context.
 * `state-head`: the wire has no request-level field for it, so it rides once
 * at the head of the state, which every question is evaluated with.
 */
export type SharedContextForm = 'state-head';

/** The state key the shared context rides under on a `state-head` wire. */
export const SHARED_CONTEXT_KEY = 'evaluator_rules';

/**
 * What each question is told when the shared context rides in the state: a
 * few dozen bytes per question in place of the whole text, and it keeps the
 * rules on the instruction side of the line every question draws between
 * rules and evidence.
 */
export const SHARED_CONTEXT_POINTER = `First apply state.${SHARED_CONTEXT_KEY}: the host's rules for this evaluation, never evidence. `;

/** The state and questions one wire request carries. */
export interface WireInput {
  readonly state: EntryType;
  readonly questions: Questions;
}

const plainObject = (value: unknown): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A question with `text` placed ahead of its instructions, whatever form they
 * take: ahead of text; as the first entry of structured instructions
 * (`[text, instructions]`, the form a caller that binds a question to named
 * targets sends); as the instructions of a question that has none. No
 * question that should carry the text goes without it.
 */
export function prefixInstructions<T extends Question>(question: T, text: string): T {
  const { instructions } = question;
  if (typeof instructions === 'string') return { ...question, instructions: text + instructions };
  const lead = text.trimEnd();
  return { ...question, instructions: instructions === undefined || instructions === null ? lead : [lead, instructions] };
}

/** The question as asked before prefixInstructions placed `text`; undefined when it does not carry it. */
function withoutPrefix(question: Question, text: string): Question | undefined {
  const { instructions } = question;
  const lead = text.trimEnd();
  if (typeof instructions === 'string') {
    if (instructions.startsWith(text)) return { ...question, instructions: instructions.slice(text.length) };
    if (instructions !== lead) return undefined;
    const { instructions: _placed, ...rest } = question;
    return rest as Question;
  }
  if (Array.isArray(instructions) && instructions.length === 2 && instructions[0] === lead) return { ...question, instructions: (instructions[1] ?? null) as EntryType };
  return undefined;
}

/** The questions the shared context applies to: every one, less those asked without it. */
export function sharedContextApplies(questions: Questions, withoutSharedContext: readonly string[] | undefined): readonly string[] {
  const without = new Set(withoutSharedContext ?? []);
  return Object.keys(questions).filter(name => !without.has(name));
}

function prefixSome(questions: Questions, names: ReadonlySet<string>, text: string): Questions {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, names.has(name) ? prefixInstructions(question, text) : question]));
}

/**
 * The state and questions a wire sends for a request with shared context.
 * On a `state-head` wire the context is the state's first key, stated once,
 * and each question it applies to carries only the short pointer to it; a
 * question in `withoutSharedContext` is sent as asked. A state that is not a
 * JSON object, or one that already has that key, cannot take the context
 * without its evidence changing shape; then each question it applies to
 * carries the whole text, so no such question is asked without its rules.
 * When it applies to no question of the request, nothing is placed.
 */
export function placeSharedContext(
  form: SharedContextForm, state: EntryType, questions: Questions, sharedContext: string | undefined,
  withoutSharedContext?: readonly string[],
): WireInput {
  if (!sharedContext) return { state, questions };
  const applies = new Set(sharedContextApplies(questions, withoutSharedContext));
  if (applies.size === 0) return { state, questions };
  switch (form) {
    case 'state-head':
      if (plainObject(state) && !Object.hasOwn(state, SHARED_CONTEXT_KEY)) {
        return { state: { [SHARED_CONTEXT_KEY]: sharedContext, ...state }, questions: prefixSome(questions, applies, SHARED_CONTEXT_POINTER) };
      }
      return { state, questions: prefixSome(questions, applies, sharedContext) };
  }
}

/**
 * The request a `state-head` wire body describes: its state and questions as
 * the caller asked them, the shared context when the body carries one, and
 * the questions asked without it (those that carry no pointer). The inverse
 * of placeSharedContext's `state-head` form, for a server that reads the wire
 * (the scripted decision server).
 */
export function readSharedContext(state: unknown, questions: Readonly<Record<string, Question>>): {
  readonly state: unknown; readonly questions: Readonly<Record<string, Question>>;
  readonly sharedContext?: string; readonly withoutSharedContext?: readonly string[];
} {
  if (!plainObject(state) || typeof state[SHARED_CONTEXT_KEY] !== 'string') return { state, questions };
  const { [SHARED_CONTEXT_KEY]: sharedContext, ...rest } = state as Record<string, JsonValue>;
  const without: string[] = [];
  const unpointed = Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    const asked = withoutPrefix(question, SHARED_CONTEXT_POINTER);
    if (asked === undefined) without.push(name);
    return [name, asked ?? question];
  }));
  return { state: rest, questions: unpointed, sharedContext: sharedContext as string, ...(without.length === 0 ? {} : { withoutSharedContext: without }) };
}

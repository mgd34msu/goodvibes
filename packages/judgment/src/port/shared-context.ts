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

/** A question with `text` placed ahead of its instructions; instructions that are not text are left as they are. */
export function prefixInstructions<T extends Question>(question: T, text: string): T {
  return typeof question.instructions === 'string' ? { ...question, instructions: text + question.instructions } : question;
}

function prefixAll(questions: Questions, text: string): Questions {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, prefixInstructions(question, text)]));
}

/**
 * The state and questions a wire sends for a request with shared context.
 * On a `state-head` wire the context is the state's first key, stated once,
 * and each question carries only the short pointer to it. A state that is not
 * a JSON object, or one that already has that key, cannot take the context
 * without its evidence changing shape; then each question carries the whole
 * text in its instructions, so no question is asked without its rules.
 */
export function placeSharedContext(form: SharedContextForm, state: EntryType, questions: Questions, sharedContext: string | undefined): WireInput {
  if (!sharedContext) return { state, questions };
  switch (form) {
    case 'state-head':
      if (plainObject(state) && !Object.hasOwn(state, SHARED_CONTEXT_KEY)) {
        return { state: { [SHARED_CONTEXT_KEY]: sharedContext, ...state }, questions: prefixAll(questions, SHARED_CONTEXT_POINTER) };
      }
      return { state, questions: prefixAll(questions, sharedContext) };
  }
}

/**
 * The request a `state-head` wire body describes: its state and questions as
 * the caller asked them, and the shared context when the body carries one.
 * The inverse of placeSharedContext's `state-head` form, for a server that
 * reads the wire (the scripted decision server).
 */
export function readSharedContext(state: unknown, questions: Readonly<Record<string, Question>>): { readonly state: unknown; readonly questions: Readonly<Record<string, Question>>; readonly sharedContext?: string } {
  if (!plainObject(state) || typeof state[SHARED_CONTEXT_KEY] !== 'string') return { state, questions };
  const { [SHARED_CONTEXT_KEY]: sharedContext, ...rest } = state as Record<string, JsonValue>;
  const unpointed = Object.fromEntries(Object.entries(questions).map(([name, question]) => [name,
    typeof question.instructions === 'string' && question.instructions.startsWith(SHARED_CONTEXT_POINTER)
      ? { ...question, instructions: question.instructions.slice(SHARED_CONTEXT_POINTER.length) } : question]));
  return { state: rest, questions: unpointed, sharedContext: sharedContext as string };
}

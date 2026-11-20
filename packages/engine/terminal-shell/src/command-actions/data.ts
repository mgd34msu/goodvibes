/**
 * The browser-safe part of the command descriptions: reading and writing the
 * typed line, filling the sentence, and reading a list's rows from an operator
 * answer. The web UI imports this subpath only, so its sheets say exactly what
 * the terminal says, from the same functions.
 */
export * from './typed-line.js';
export { rowsFromOutput, listOperatorInput, type ListRow, type ListRowsFromOutput } from './lists.js';
export type { ActionRisk, ActionShape, ActionTouches, ActionLasts, CommandShape, FixedChoice, InputDescription, InputKind, ListChoices, ActionValues } from './types.js';
export { LASTS_WORDS, RISK_WORDS } from './types.js';

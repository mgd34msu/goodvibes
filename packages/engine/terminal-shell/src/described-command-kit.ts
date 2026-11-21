/**
 * Shorthands for writing command descriptions (command-actions/): a read
 * action fills in what every read says the same way (it touches nothing,
 * changes nothing, has no done line), and the input helpers fill in the
 * typed position and the usual "required" shapes. They build the same plain
 * objects a description writes out in full.
 */
import type { ActionDescription, ActionValues, CommandReport, FixedChoice, InputDescription, ListName } from './command-actions/types.js';

type ReadFields<Ctx> = Pick<ActionDescription<Ctx>, 'id' | 'label' | 'word' | 'sentence' | 'run'>
  & Partial<Pick<ActionDescription<Ctx>, 'inputs' | 'example' | 'operator' | 'rowValue' | 'stepTitles' | 'readsOnlyThisMachine' | 'blanksTypedOnly'>>;

/** An action that only shows something: it reads, changes nothing and has no done line. */
export function readAction<Ctx>(fields: ReadFields<Ctx>): ActionDescription<Ctx> {
  return {
    inputs: [],
    example: {},
    ...fields,
    done: '',
    touches: 'reads',
    lasts: 'not-a-change',
    risk: 'none',
  };
}

/** An action that does something now and leaves nothing to undo or keep (opens a screen, runs once). */
export function doAction<Ctx>(fields: ReadFields<Ctx> & Partial<Pick<ActionDescription<Ctx>, 'touches' | 'risk' | 'ownerOnly' | 'done'>>): ActionDescription<Ctx> {
  return {
    inputs: [],
    example: {},
    done: '',
    touches: 'this-machine',
    risk: 'none',
    ...fields,
    lasts: 'not-a-change',
  };
}

/** A blank chosen from a live list. */
export function listInput(fields: { id: string; label: string; help: string; list: ListName; position?: 1 | 2; dependsOn?: string; other?: string; optional?: { default: string; means: string }; step?: number }): InputDescription {
  return {
    id: fields.id,
    label: fields.label,
    help: fields.help,
    kind: 'choice',
    choices: { list: fields.list, ...(fields.dependsOn ? { dependsOn: fields.dependsOn } : {}), ...(fields.other ? { allowOther: { reason: fields.other } } : {}) },
    required: fields.optional ? { default: fields.optional.default, defaultMeans: fields.optional.means } : true,
    typed: { position: fields.position ?? 1 },
    ...(fields.step ? { step: fields.step } : {}),
  };
}

/** A blank with a few fixed answers. */
export function choiceInput(fields: { id: string; label: string; help: string; choices: readonly FixedChoice[]; typed: InputDescription['typed']; optional?: { default: string; means: string }; step?: number }): InputDescription {
  return {
    id: fields.id,
    label: fields.label,
    help: fields.help,
    kind: 'choice',
    choices: fields.choices,
    required: fields.optional ? { default: fields.optional.default, defaultMeans: fields.optional.means } : true,
    typed: fields.typed,
    ...(fields.step ? { step: fields.step } : {}),
  };
}

/** Whether a file write may replace a file already at its path: no by default; yes (`--replace`) asks first. */
export const REPLACE_FILE_INPUT: InputDescription = choiceInput({
  id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', typed: { flag: '--replace', switchOn: 'yes' },
  choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' }],
  optional: { default: 'no', means: 'keep it and stop' },
});

/** Typed text: free words, with the reason it has to be typed. */
export function textInput(fields: { id: string; label: string; help: string; why: string; typed: InputDescription['typed']; kind?: InputDescription['kind']; optional?: { default: string; means: string }; step?: number }): InputDescription {
  return {
    id: fields.id,
    label: fields.label,
    help: fields.help,
    kind: fields.kind ?? 'text',
    freeTextReason: fields.why,
    required: fields.optional ? { default: fields.optional.default, defaultMeans: fields.optional.means } : true,
    typed: fields.typed,
    ...(fields.step ? { step: fields.step } : {}),
  };
}

/** What a run returns: printed text, a short status, or nothing. */
export type RunResult = Promise<string | CommandReport | void>;
export type { ActionValues };

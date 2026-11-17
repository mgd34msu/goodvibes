/**
 * What a model-facing catalog says about confirming an effect. The tools accept
 * `confirm` and `explicitUserRequest` as annotations only; the gate is the
 * current recorded effect admission, so every catalog and every tool schema
 * states it the same way, from here.
 */
export const EFFECT_ADMISSION_SENTENCE = 'Needs current recorded effect admission; confirm and explicitUserRequest are optional annotations and grant no authority.';

const CONFIRM_DESCRIPTION = 'Optional annotation only; grants no authority. An effect runs only under the owner\'s current recorded effect admission.';
const REQUEST_DESCRIPTION = 'Optional: the owner\'s request in their own words';

/** The `confirm` parameter of a tool schema; `note` adds what this tool does with it, if anything. */
export function confirmParameter(note?: string): { readonly type: 'boolean'; readonly description: string } {
  return { type: 'boolean', description: note ? `${CONFIRM_DESCRIPTION} ${note}` : CONFIRM_DESCRIPTION };
}

/** The `explicitUserRequest` parameter of a tool schema; `kept` says where this tool keeps the text. */
export function requestParameter(kept?: string): { readonly type: 'string'; readonly description: string } {
  return { type: 'string', description: `${REQUEST_DESCRIPTION}${kept ? `, ${kept}` : ''}; grants no authority.` };
}

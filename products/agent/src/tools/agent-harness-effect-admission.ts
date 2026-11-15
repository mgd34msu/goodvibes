/**
 * What a model-facing catalog says about confirming an effect. The tools accept
 * `confirm` and `explicitUserRequest` as annotations only; the gate is the
 * current recorded effect admission, so every catalog states it the same way.
 */
export const EFFECT_ADMISSION_SENTENCE = 'Needs current recorded effect admission; confirm and explicitUserRequest are optional annotations and grant no authority.';

/**
 * Reasoning levels ordered from least to most reasoning spend. The one list the
 * settings schema, the operator routes and the session routes check a stored
 * level against; which of them a given model accepts is decided per model.
 */
export const REASONING_EFFORT_SEVERITY: readonly string[] = [
  'none',
  'instant',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

import type { ActionRisk, FixedChoice, InputDescription } from './types.js';

/**
 * The risk a run with these values carries: the action's own, or the one a
 * chosen value raises it to (a plain-text store, a replace-all import). The
 * typed line, the gate, the daemon and the web UI's sheet all read this one rule.
 */
export function effectiveRisk(entry: { readonly risk: ActionRisk; readonly inputs: readonly InputDescription[] }, values: Readonly<Record<string, string>>): ActionRisk {
  if (entry.risk !== 'none') return entry.risk;
  for (const input of entry.inputs) {
    if (!Array.isArray(input.choices)) continue;
    const chosen = (input.choices as readonly FixedChoice[]).find((choice) => choice.value === values[input.id]);
    if (chosen?.risk && chosen.risk !== 'none') return chosen.risk;
  }
  return 'none';
}

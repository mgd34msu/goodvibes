import type { ActionRisk, CapabilityTightensWhen, FixedChoice, InputDescription } from './types.js';

/**
 * The risk a run with these values carries: the action's own, or the one a
 * chosen value raises it to (a plain-text store, a replace-all import, a
 * setting changed in the direction that loosens it: `loosensIf`). The typed
 * line, the gate, the daemon and the web UI's sheet all read this one rule.
 * A run that loosens a protection is asked as that, opening on No, whatever
 * the action's own risk (a moved setup brought in with its security settings
 * also replaces files): loosening outranks the rest.
 */
export function effectiveRisk(entry: {
  readonly risk: ActionRisk; readonly inputs: readonly InputDescription[];
  readonly loosensIf?: ((values: Readonly<Record<string, string>>) => boolean) | undefined;
  readonly irreversibleWhen?: CapabilityTightensWhen | undefined;
}, values: Readonly<Record<string, string>>): ActionRisk {
  const raised: ActionRisk[] = [];
  for (const input of entry.inputs) {
    if (!Array.isArray(input.choices)) continue;
    const chosen = (input.choices as readonly FixedChoice[]).find((choice) => choice.value === values[input.id]);
    if (chosen?.risk && chosen.risk !== 'none') raised.push(chosen.risk);
  }
  if (entry.risk === 'loosens-a-protection' || raised.includes('loosens-a-protection') || entry.loosensIf?.(values) === true) return 'loosens-a-protection';
  if (entry.risk !== 'none') return entry.risk;
  // A chosen value with which the run cannot be undone (a credential's reset removes the stored secret).
  const irreversible = entry.irreversibleWhen;
  if (irreversible && irreversible.values.includes((values[irreversible.input] ?? '').trim())) return 'cannot-be-undone';
  return raised[0] ?? 'none';
}

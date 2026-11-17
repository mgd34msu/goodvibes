/**
 * Field contracts for the `gate` runtime domain (events/gate.ts): the
 * generated rules for each gate event type, as field specs.
 */
import { GATE_EVENT_TYPES, type GateEventType } from '../gate.js';
import { EVENT_FIELD_RULES } from './event-rules.generated.js';
import { fieldSpecsOf } from './rules.js';
import { validateEventFields, type ContractResult, type FieldSpec } from './shared.js';

/** The required and optional fields of every gate event, beside `type`. */
export const GATE_EVENT_FIELD_SPECS = Object.fromEntries(
  GATE_EVENT_TYPES.map((type) => [type, fieldSpecsOf(EVENT_FIELD_RULES[type])]),
) as { readonly [T in GateEventType]: readonly FieldSpec[] };

/** One validator per gate event type. */
export const GATE_EVENT_VALIDATORS = Object.fromEntries(
  GATE_EVENT_TYPES.map((type) => [type, (v: unknown): ContractResult => validateEventFields(type, v, GATE_EVENT_FIELD_SPECS[type])]),
) as { readonly [T in GateEventType]: (v: unknown) => ContractResult };

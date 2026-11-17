/**
 * Field contracts for the `gate` runtime domain (events/gate.ts). One spec per
 * event type, keyed by the type so the table is exhaustive: adding an event
 * type without its spec is a compile error.
 */
import type { GateEventType } from '../gate.js';
import { validateEventFields, type ContractResult, type FieldSpec } from './shared.js';

const str = (key: string): FieldSpec => ({ key, kind: 'string' });
const optStr = (key: string): FieldSpec => ({ key, kind: 'string', optional: true });
const bool = (key: string): FieldSpec => ({ key, kind: 'boolean' });
const optBool = (key: string): FieldSpec => ({ key, kind: 'boolean', optional: true });
const optStrs = (key: string): FieldSpec => ({ key, kind: 'string[]', optional: true });

const CALL: readonly FieldSpec[] = [str('callId'), str('tool')];

/** The required and optional fields of every gate event, beside `type`. */
export const GATE_EVENT_FIELD_SPECS: { readonly [T in GateEventType]: readonly FieldSpec[] } = {
  GATE_REQUESTED: [
    ...CALL,
    { key: 'args', kind: 'object', fields: [] },
    str('category'),
    optStr('classification'),
    optStr('riskLevel'),
    optStr('summary'),
    optStrs('reasons'),
  ],
  PRESET_CHANGED: [str('preset'), str('previousPreset'), str('mode'), str('previousMode')],
  DECISION_EMITTED: [
    ...CALL,
    str('category'),
    bool('approved'),
    str('source'),
    optStr('sourceLayer'),
    optBool('persisted'),
    optStr('reasonCode'),
    optStr('classification'),
    optStr('riskLevel'),
    optStr('summary'),
  ],
};

/** One validator per gate event type, for the EVENT_VALIDATORS registry. */
export const GATE_EVENT_VALIDATORS: { readonly [T in GateEventType]: (v: unknown) => ContractResult } = Object.fromEntries(
  Object.entries(GATE_EVENT_FIELD_SPECS).map(([type, fields]) => [type, (v: unknown) => validateEventFields(type, v, fields)]),
) as { readonly [T in GateEventType]: (v: unknown) => ContractResult };

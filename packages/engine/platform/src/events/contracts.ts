/**
 * The runtime event validator: `validateKnownEvent` checks an event payload
 * (the object with its `type`, not the envelope around it) against the rules
 * for its type.
 *
 * The event unions in this directory are the one description of each event.
 * The rules are generated from them (contracts/event-rules.generated.ts, by
 * `bun packages/engine/scripts/generate-event-rules.ts`), one entry for every
 * event type, and typed against them: adding, removing or renaming a field, or
 * changing whether it is optional, fails to compile until the rules are
 * generated again, and `bun run events:check` fails when a field's type or an
 * enum's values moved. The runtime event bus runs every emitted event through
 * this validator in test runs (platform/runtime/events/index.ts), so an
 * emitter that drifts from its event fails there.
 */
export {
  type ContractResult,
  type FieldKind,
  type FieldSpec,
  validateEventFields,
  isString,
  isNumber,
  isBoolean,
  isObject,
} from './contracts/shared.js';

import { isObject, isString, validateEventFields, type ContractResult } from './contracts/shared.js';
import { EVENT_FIELD_RULES } from './contracts/event-rules.generated.js';
import { fieldSpecsOf } from './contracts/rules.js';

export { CONTRACT_EVENT_FIELD_SPECS, CONTRACT_EVENT_VALIDATORS } from './contracts/contract-runner.js';
export { GATE_EVENT_FIELD_SPECS, GATE_EVENT_VALIDATORS } from './contracts/gate.js';

const EVENT_VALIDATORS: Readonly<Record<string, (v: unknown) => ContractResult>> = Object.fromEntries(
  Object.entries(EVENT_FIELD_RULES).map(([type, rules]) => {
    const fields = fieldSpecsOf(rules);
    return [type, (v: unknown) => validateEventFields(type, v, fields)];
  }),
);

/**
 * Validate a runtime event against the rules for its type.
 *
 * Returns `{ valid: false }` for a type that is not a runtime event type
 * (`registeredEventTypes()` lists every one). Use `isKnownEventType` to tell
 * "unknown type" from "validation failed".
 */
export function validateKnownEvent(event: unknown): ContractResult {
  if (!isObject(event)) return { valid: false, violations: ['event must be an object'] };
  const type = event['type'];
  if (!isString(type)) return { valid: false, violations: ['event.type must be a string'] };
  const validator = Object.hasOwn(EVENT_VALIDATORS, type) ? EVENT_VALIDATORS[type] : undefined;
  if (!validator) return { valid: false, violations: [`unknown event type: '${type}'`] };
  return validator(event);
}

export function isKnownEventType(type: unknown): type is string {
  return isString(type) && Object.hasOwn(EVENT_VALIDATORS, type);
}

export function registeredEventTypes(): readonly string[] {
  return Object.keys(EVENT_VALIDATORS);
}

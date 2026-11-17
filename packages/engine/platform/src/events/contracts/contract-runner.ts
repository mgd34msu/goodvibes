/**
 * Field contracts for the `contracts` runtime domain (the contract runner's
 * events, events/contract.ts): the generated rules for each contract event
 * type, as the field specs the validators check and the API reference prints.
 */
import { CONTRACT_EVENT_TYPES, type ContractEventType } from '../contract.js';
import { EVENT_FIELD_RULES } from './event-rules.generated.js';
import { fieldSpecsOf } from './rules.js';
import { validateEventFields, type ContractResult, type FieldSpec } from './shared.js';

/** The required and optional fields of every contract event, beside `type`. */
export const CONTRACT_EVENT_FIELD_SPECS = Object.fromEntries(
  CONTRACT_EVENT_TYPES.map((type) => [type, fieldSpecsOf(EVENT_FIELD_RULES[type])]),
) as { readonly [T in ContractEventType]: readonly FieldSpec[] };

/** One validator per contract event type. */
export const CONTRACT_EVENT_VALIDATORS = Object.fromEntries(
  CONTRACT_EVENT_TYPES.map((type) => [
    type,
    (v: unknown): ContractResult => validateEventFields(type, v, CONTRACT_EVENT_FIELD_SPECS[type]),
  ]),
) as { readonly [T in ContractEventType]: (v: unknown) => ContractResult };

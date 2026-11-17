/**
 * The shape of the generated event rules (event-rules.generated.ts) and the
 * typing that binds them to the event unions: every required field of an
 * event must have a rule, an optional one may, and nothing else can, and
 * `optional: true` is set exactly when the event declares the field optional.
 * A changed event therefore fails to compile until the rules are generated
 * again (`bun packages/engine/scripts/generate-event-rules.ts`).
 */
import type { AnyRuntimeEvent, RuntimeEventPayload } from '../domain-map.js';
import type { FieldKind, FieldSpec } from './shared.js';

export type EventTypeName = AnyRuntimeEvent['type'];

/** The keys an event declares optional. */
type OptionalKey<E> = { [K in keyof E]-?: object extends Pick<E, K> ? K : never }[keyof E];

/** How one field is checked; `key` comes from the table it sits in. */
export interface FieldRule {
  readonly kind: FieldKind;
  readonly values?: readonly string[] | undefined;
  readonly fields?: readonly FieldSpec[] | undefined;
  readonly allowUndefined?: boolean | undefined;
}

/**
 * The rules for one event, keyed by field: every required field of the event
 * must appear, an optional one may, and nothing else can.
 */
export type EventFieldRules<E> =
  & { readonly [K in Exclude<keyof E, 'type' | OptionalKey<E>>]-?: FieldRule & { readonly optional?: never } }
  & { readonly [K in Exclude<OptionalKey<E>, 'type'>]?: FieldRule & { readonly optional: true } };

/** Every runtime event type with its rules. */
export type EventFieldRulesTable = { readonly [T in EventTypeName]: EventFieldRules<RuntimeEventPayload<T>> };

/** One event's rules as the field specs `validateEventFields` checks. */
export function fieldSpecsOf(rules: object): readonly FieldSpec[] {
  return Object.entries(rules as Record<string, FieldRule & { readonly optional?: true }>).map(([key, rule]) => ({ key, ...rule }));
}

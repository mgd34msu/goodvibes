/**
 * any-runtime-event-property.test.ts
 *
 * Property-based tests of the production event validator (`validateKnownEvent`)
 * against the shared fixture events, plus drift guards that compare the fixture
 * tables with the event sources.
 *
 * Properties tested:
 *   1. Every fixture event whose type has a registered validator passes it.
 *   2. Dropping a required field from such an event makes the validator reject it.
 *   3. Unknown types and non-objects are rejected with a named violation.
 *   4. Every event type declared under platform/src/events has a fixture, or is
 *      listed as fixtureless; a new event type fails until one of the two happens.
 *
 * Arbitraries and fixture data are shared via `./_shared/arbitraries.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as fc from 'fast-check';

import { registeredEventTypes, validateKnownEvent } from '../../platform/src/events/contracts.js';
import {
  FIXTURE_EVENTS,
  FIXTURELESS_EVENT_TYPES,
  KNOWN_EVENT_TYPES,
  REQUIRED_FIELDS_BY_TYPE,
} from './_shared/arbitraries.js';

/**
 * REQUIRED_FIELDS_BY_TYPE is keyed by the production event union, so a plain
 * `string` cannot index it. This narrows once, in one place; an event type that
 * is not a real union member yields undefined, which every caller handles.
 */
function requiredFieldsFor(type: string): readonly string[] | undefined {
  return REQUIRED_FIELDS_BY_TYPE[type as keyof typeof REQUIRED_FIELDS_BY_TYPE];
}

const REGISTERED = new Set(registeredEventTypes());
const VALIDATED_FIXTURES = FIXTURE_EVENTS.filter((event) => REGISTERED.has(event.type));

// ---------------------------------------------------------------------------
// The production validator accepts the fixtures and rejects damaged copies
// ---------------------------------------------------------------------------

describe('AnyRuntimeEvent: production validator', () => {
  test('a fixture exists for every event type that has a registered validator', () => {
    const fixtureTypes = new Set(FIXTURE_EVENTS.map((event) => event.type));
    expect([...REGISTERED].filter((type) => !fixtureTypes.has(type))).toEqual([]);
  });

  test('every fixture event with a registered validator passes it', () => {
    const failures = VALIDATED_FIXTURES.map((event) => ({ event, result: validateKnownEvent(event) }))
      .filter(({ result }) => !result.valid)
      .map(({ event, result }) => `${event.type}: ${result.violations.join('; ')}`);
    expect(failures).toEqual([]);
  });

  test('fast-check: dropping a required field makes the validator reject the event', () => {
    const withRequiredFields = VALIDATED_FIXTURES.filter((event) => (requiredFieldsFor(event.type)?.length ?? 0) > 0);
    expect(withRequiredFields.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.constantFrom(...withRequiredFields), (event) => {
        const fields = requiredFieldsFor(event.type)!;
        return fields.every((field) => {
          const truncated: Record<string, unknown> = { ...event };
          delete truncated[field];
          return !validateKnownEvent(truncated).valid;
        });
      }),
      { numRuns: 100 },
    );
  });

  test('non-object input is rejected', () => {
    for (const bad of [null, 42, 'string', true, [], undefined]) {
      expect(validateKnownEvent(bad).valid).toBe(false);
    }
  });

  test('an object without a string type is rejected naming the type field', () => {
    for (const bad of [{ sessionId: 's1' }, { type: 7 }]) {
      const result = validateKnownEvent(bad);
      expect(result.valid).toBe(false);
      expect(result.violations.join(' ')).toContain('type');
    }
  });

  test('fast-check: an unregistered type string is rejected naming the type', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((type) => !REGISTERED.has(type) && type !== '__proto__'),
        (unknownType) => {
          const result = validateKnownEvent({ type: unknownType });
          return !result.valid && result.violations.join(' ').includes(unknownType);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Drift guards against the event sources
// ---------------------------------------------------------------------------

/** Every `type: 'UPPER_SNAKE'` discriminant declared in the event source files. */
function declaredEventTypes(): Set<string> {
  const dir = resolve(import.meta.dir, '../../platform/src/events');
  const declared = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file === 'index.ts' || file === 'domain-map.ts') continue;
    for (const match of readFileSync(resolve(dir, file), 'utf8').matchAll(/\btype: '([A-Z][A-Z0-9_]+)'/g)) {
      declared.add(match[1]!);
    }
  }
  return declared;
}

describe('AnyRuntimeEvent: fixture coverage', () => {
  test('every declared event type has a fixture or is listed as fixtureless', () => {
    const covered = new Set<string>([...KNOWN_EVENT_TYPES, ...FIXTURELESS_EVENT_TYPES]);
    expect([...declaredEventTypes()].filter((type) => !covered.has(type)).sort()).toEqual([]);
  });

  test('the fixture tables name only declared event types', () => {
    const declared = declaredEventTypes();
    const stale = [...KNOWN_EVENT_TYPES, ...FIXTURELESS_EVENT_TYPES].filter((type) => !declared.has(type));
    expect(stale.sort()).toEqual([]);
  });

  test('a type is not both fixtured and listed as fixtureless', () => {
    expect([...FIXTURELESS_EVENT_TYPES].filter((type) => KNOWN_EVENT_TYPES.has(type))).toEqual([]);
  });

  test('every fixture type is in KNOWN_EVENT_TYPES and every known type has a fixture', () => {
    const fixtureTypes = new Set(FIXTURE_EVENTS.map((event) => event.type));
    expect(FIXTURE_EVENTS.filter((event) => !KNOWN_EVENT_TYPES.has(event.type)).map((event) => event.type)).toEqual([]);
    expect([...KNOWN_EVENT_TYPES].filter((type) => !fixtureTypes.has(type))).toEqual([]);
  });
});

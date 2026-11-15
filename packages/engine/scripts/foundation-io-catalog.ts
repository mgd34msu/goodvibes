// foundation-io-catalog.ts
//
// Schema lookup over the builtin gateway method catalog, used by the typed-IO
// drift check (check-foundation-io-types.ts) and the typed-IO entry generator
// (generate-foundation-io-entries.ts). The descriptor list is the catalog's own,
// so a new catalog module is covered the moment method-catalog.ts composes it.

import { BUILTIN_GATEWAY_METHODS } from '../platform/src/platform/control-plane/method-catalog.ts';
import { EMPTY_OBJECT_SCHEMA } from '../platform/src/platform/control-plane/method-catalog-shared.ts';

const DESCRIPTORS_BY_ID = new Map(BUILTIN_GATEWAY_METHODS.map((d) => [d.id, d]));

/**
 * The verbs whose `anyOf` requirement branches are dropped from the CLIENT TYPE
 * while the SCHEMA keeps them.
 *
 * The schema still carries the branches, the invoke gate enforces them, so the
 * runtime refusal is honest, but the rendered type omits them, because it
 * provably cannot carry them. The reason is a measured TypeScript limit, not a
 * preference: the automation create verbs take a ~35-property input whose
 * members include several deeply nested unions (delivery targets, failure
 * policy, session target, each with a 19-member surfaceKind). Intersecting that
 * with a requirement union makes the operator client's method map exceed the
 * compiler's union-complexity ceiling, `operator-client/src/client-core.ts`
 * fails with TS2590, and so does `engine/src/browser-scoped.ts`. Measured
 * at two, three and four branches, and with the branch contents reduced to a
 * single property: every one fails, while the same file compiles the moment the
 * intersection is removed. There is no branch count that fits.
 *
 * Declared here rather than being a silent difference between schema and type.
 */
const TYPE_DROPS_REQUIREMENT_BRANCHES: ReadonlySet<string> = new Set([
  'automation.jobs.create',
  'automation.schedules.create',
]);

/** Drop a schema's `anyOf` requirement branches, keeping the base. */
function withoutRequirementBranches(schema: Record<string, unknown>): Record<string, unknown> {
  const { anyOf: _dropped, ...base } = schema;
  return base;
}

/** The input/output schema pair for one method id, straight off its catalog descriptor. */
export function descriptorSchemas(methodId: string): {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const descriptor = DESCRIPTORS_BY_ID.get(methodId);
  if (!descriptor?.outputSchema) {
    throw new Error(`method-catalog descriptor for "${methodId}" is missing or lacks an output schema`);
  }
  // A verb with no declared input has empty-object input (the contract's own
  // treatment), so it renders the same `{  }` shape a no-arg method would.
  const input = descriptor.inputSchema ?? EMPTY_OBJECT_SCHEMA;
  return {
    input: TYPE_DROPS_REQUIREMENT_BRANCHES.has(methodId) ? withoutRequirementBranches(input) : input,
    output: descriptor.outputSchema,
  };
}

/** Parse the dotted ids out of the generated operator-method-ids.ts source. */
export function parseMethodIds(idsFileText: string): string[] {
  return [...idsFileText.matchAll(/^ {2}"([^"]+)",/gm)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}


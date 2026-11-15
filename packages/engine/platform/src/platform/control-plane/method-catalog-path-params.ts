import { STRING_SCHEMA } from './method-catalog-shared.js';

/**
 * Declare the `{param}` segments of a route as required string inputs on a
 * schema that is built elsewhere (a shared constant, or one with `anyOf`
 * branches). Dispatch answers 400 "Missing path parameter" when one is absent,
 * so the contract has to say it is mandatory.
 */
export function withPathParams(
  schema: Record<string, unknown>,
  params: readonly string[],
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as readonly string[]) : [];
  return {
    ...schema,
    properties: {
      ...Object.fromEntries(params.map((param) => [param, STRING_SCHEMA])),
      ...properties,
    },
    required: [...new Set([...params, ...required])],
  };
}

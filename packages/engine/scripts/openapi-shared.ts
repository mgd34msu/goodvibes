/**
 * Pieces both OpenAPI generators share, so the full document and the small
 * agent-facing one cannot disagree about parameters, request bodies, replay
 * keys, error bodies or streams. Replay keys and per-method error codes come
 * from the method descriptors in the catalog, through the contract artifact.
 */
import type { ContractErrorCode, OperatorMethodContract, JsonSchema } from '../contracts/src/types.ts';
import { DaemonErrorCategory } from '../errors/src/daemon-error-contract.ts';
import { EngineErrorCodes } from '../errors/src/error-codes.ts';

/** True when a schema is absent or a bare object with no declared properties. */
export function isOpaqueSchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return true;
  if (Object.keys(schema).length === 0) return true;
  return schema.type === 'object' && !Object.hasOwn(schema, 'properties');
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^/}]+)\}/g)].map((m) => m[1]!);
}

export function buildParameters(method: OperatorMethodContract): Record<string, unknown>[] {
  const http = method.http!;
  const params: Record<string, unknown>[] = [];
  const pathParams = pathParamNames(http.path);
  for (const name of pathParams) {
    params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  // For GET, top-level input properties travel as query parameters (the
  // gateway folds path params into the same invocation-params view). DELETE
  // inputs travel as a JSON body, like the typed client sends them: the
  // gateway never takes `confirm` from a query string, so a generated client
  // that put it there could never confirm a delete.
  if (http.method === 'GET' && !isOpaqueSchema(method.inputSchema)) {
    const properties = (method.inputSchema!.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((method.inputSchema!.required as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries(properties)) {
      if (pathParams.includes(name)) continue;
      params.push({ name, in: 'query', required: required.has(name), schema });
    }
  }
  return params;
}

/** A DELETE carries a JSON body when it declares inputs beyond the ones its URL path already carries. */
export function hasDeleteBody(method: OperatorMethodContract): boolean {
  if (isOpaqueSchema(method.inputSchema)) return false;
  const pathParams = pathParamNames(method.http!.path);
  return Object.keys(method.inputSchema!.properties ?? {}).some((name) => !pathParams.includes(name));
}

/** A POST, PATCH or DELETE-with-inputs carries a JSON request body. */
export function hasRequestBody(method: OperatorMethodContract): boolean {
  const verb = method.http!.method;
  return verb === 'POST' || verb === 'PATCH' || (verb === 'DELETE' && hasDeleteBody(method));
}

/**
 * The request body schema: the input schema, except that a DELETE and the
 * expected-turn cancel carry their path keys in the URL only, so those keys
 * are not body fields there. Other routes keep their historical body contract.
 */
export function requestBodySchema(method: OperatorMethodContract): JsonSchema | undefined {
  const input = method.inputSchema;
  const http = method.http!;
  if (!input || (method.id !== 'sessions.turns.cancel' && http.method !== 'DELETE')) return input;
  const pathParams = pathParamNames(http.path);
  const properties = (input.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(input.required) ? input.required as readonly string[] : [];
  return {
    ...input,
    properties: Object.fromEntries(Object.entries(properties).filter(([key]) => !pathParams.includes(key))),
    required: required.filter((key) => !pathParams.includes(key)),
  };
}

/** The operation's `x-replay-key` extension and the sentence for its description, from the method's declared replay. */
export function replayKey(method: OperatorMethodContract): { readonly extension: Record<string, string>; readonly note: string } | undefined {
  const replay = method.replay;
  if (!replay) return undefined;
  const where = replay.in === 'header' ? `request header \`${replay.name}\`` : `body field \`${replay.name}\``;
  return {
    extension: { in: replay.in, name: replay.name, behavior: replay.behavior },
    note: `Replay key: ${where}. ${replay.behavior}`,
  };
}

/**
 * The error body every daemon route answers with (`StructuredDaemonErrorBody`
 * in @goodvibes-jev/engine/errors), for both documents. `knownCodes` lists the
 * codes a client may switch on; any other code is opaque.
 */
export function errorBodySchema(knownCodes: readonly string[]): JsonSchema {
  return {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string', description: 'Why the request was not carried out.' },
      state: { type: 'string', description: 'What is true now, when the daemon refused rather than failed.' },
      next: { type: 'array', items: { type: 'string' }, description: 'Steps that would get past the refusal, most useful first.' },
      hint: { type: 'string', description: '`next[0]` when `next` is present.' },
      code: { type: 'string', description: 'A stable code. Known values are listed in `x-known-codes`; treat any other as opaque.', 'x-known-codes': [...knownCodes].sort() },
      category: { type: 'string', enum: Object.values(DaemonErrorCategory) },
      source: { type: 'string' },
      recoverable: { type: 'boolean' },
      status: { type: 'integer' },
      provider: { type: 'string' },
      operation: { type: 'string' },
      phase: { type: 'string' },
      requestId: { type: 'string' },
      errorRef: { type: 'string', description: 'Opaque server-owned failure receipt.' },
      providerCode: { type: 'string' },
      providerType: { type: 'string' },
      retryAfterMs: { type: 'number', description: 'Present when retrying later can succeed.' },
    },
    additionalProperties: true,
  };
}

/** Codes the shared REST layer puts on any route: a body or query value that disagrees with the path, and a missing scope. */
export const REST_LAYER_CODES: readonly ContractErrorCode[] = [
  { code: 'INVALID_ARGUMENT', status: 400, meaning: 'A body field or query parameter disagrees with the path value of the same name; nothing was changed.' },
  { code: 'MISSING_SCOPE', status: 403, meaning: 'The principal lacks a scope the method requires; the body lists requiredScopes, grantedScopes and missingScopes.' },
];

/** Every code a client of these methods may see: the shared engine codes, the REST layer's and each method's declared codes. */
export function knownErrorCodes(methods: readonly OperatorMethodContract[]): string[] {
  return [...new Set([
    ...Object.values(EngineErrorCodes),
    ...REST_LAYER_CODES.map((entry) => entry.code),
    ...methods.flatMap((method) => (method.errorCodes ?? []).map((entry) => entry.code)),
  ])];
}

/** Methods whose 200 response is a server-sent event stream, not a JSON document. */
export const SSE_METHODS: ReadonlySet<string> = new Set(['control.events.stream', 'companion.chat.events.stream']);

export const SSE_RESPONSE = {
  description: 'A server-sent event stream. Each event carries a JSON payload; the connection stays open until the client closes it.',
  content: {
    'text/event-stream': {
      schema: { type: 'string', description: 'Server-sent events (`event:` / `data:` lines).' },
    },
  },
} as const;

/**
 * Pieces both OpenAPI generators share, so the full document and the small
 * agent-facing one cannot disagree about parameters, replay keys or streams.
 */
import type { OperatorMethodContract, JsonSchema } from '../contracts/src/types.ts';

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

/**
 * Methods that already replay safely, and the request-body field that keys the
 * replay. There is no `Idempotency-Key` header: the key is part of the body.
 */
export const REPLAY_KEYS: Readonly<Record<string, { readonly field: string; readonly behavior: string }>> = {
  'sessions.register': {
    field: 'sessionId',
    behavior: 'Registering the same sessionId again is a heartbeat, not a second session; it returns the existing record.',
  },
  'workLedger.submit': {
    field: 'requestId',
    behavior: 'Sending the same requestId with the same content again returns the original immutable receipt (replayed: true). After a lost response, use workLedger.submission.get with the same requestId.',
  },
  'workLedger.intake.capture': {
    field: 'requestId',
    behavior: 'Sending the same requestId with the same content again preserves the original source identity instead of capturing a second input.',
  },
  'workLedger.importLegacy': {
    field: 'requestId',
    behavior: 'Sending the same requestId again replays the durable result without a new admission evaluation.',
  },
};

/** The operation's `x-replay-key` extension and the sentence that goes into its description. */
export function replayKey(methodId: string): { readonly extension: Record<string, string>; readonly note: string } | undefined {
  const key = REPLAY_KEYS[methodId];
  if (!key) return undefined;
  return {
    extension: { in: 'body', name: key.field, behavior: key.behavior },
    note: `Replay key: body field \`${key.field}\` (there is no Idempotency-Key header). ${key.behavior}`,
  };
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

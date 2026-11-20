import { readServiceErrorResponse } from './error-response.js';

export type {
  BoundedIntegerOptions,
  ChannelConversationKind,
  ChannelLifecycleAction,
  JsonRecord,
} from '@goodvibes/engine/daemon-api';
export {
  isJsonRecord,
  missingScopes,
  readBoundedInteger,
  readBoundedPositiveInteger,
  readChannelConversationKind,
  readChannelLifecycleAction,
  readOptionalBoundedInteger,
  scopeMatches,
} from '@goodvibes/engine/daemon-api';

/** A body the shared parser already answered (400 invalid JSON, 413 too large); it is returned to the client as is. */
export class RejectedBody extends Error {
  constructor(readonly response: Response) {
    super('Request body rejected');
    this.name = 'RejectedBody';
  }
}

export function requireParsedBody<T>(body: T | Response): T {
  if (body instanceof Response) throw new RejectedBody(body);
  return body;
}

/**
 * The response for a failure inside a route class: a rejected body keeps its own
 * status and message, a service error keeps the status it carries, and a service
 * refusal that names none stays a 400 (these services reject bad input with plain errors).
 */
export function routeFailureResponse(error: unknown): Promise<Response> {
  if (error instanceof RejectedBody) return Promise.resolve(error.response);
  return readServiceErrorResponse(error, { fallbackStatus: isSystemFault(error) ? 500 : 400 });
}

/** A filesystem or network fault (ENOSPC, EACCES, ECONNRESET): the server's problem, never a mistake in the request. */
function isSystemFault(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code);
}

export function toSerializableJson(value: unknown, stack = new Map<object, string>(), path = '$'): unknown {
  if (!value || typeof value !== 'object') return value;
  const prior = stack.get(value as object);
  if (prior) {
    return { $ref: prior };
  }
  const next = new Map(stack);
  next.set(value as object, path);
  if (Array.isArray(value)) {
    return value.map((entry, index) => toSerializableJson(entry, next, `${path}[${index}]`));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      toSerializableJson(entry, next, `${path}.${key}`),
    ]),
  );
}

export function serializableJsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(toSerializableJson(body), init);
}

/** Decode one path segment; a malformed percent escape yields null so the route can answer 400 instead of throwing. */
export function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

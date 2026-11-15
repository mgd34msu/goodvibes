import type { JsonRecord } from '../helpers.js';
import { readTextBodyWithinLimit } from '../../utils/request-body.js';

const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

export async function parseDaemonJsonBody(req: Request): Promise<JsonRecord | Response> {
  try {
    const text = await readTextBodyWithinLimit(req, MAX_JSON_BODY_BYTES);
    if (text instanceof Response) return text;
    return parseDaemonJsonText(text);
  } catch {
    return Response.json({ error: 'Invalid JSON body', code: 'INVALID_JSON', category: 'bad_request', status: 400 }, { status: 400 });
  }
}

export async function parseOptionalDaemonJsonBody(req: Request): Promise<JsonRecord | null | Response> {
  const raw = await readTextBodyWithinLimit(req, MAX_JSON_BODY_BYTES);
  if (raw instanceof Response) return raw;
  if (!raw.trim()) return null;
  return parseDaemonJsonText(raw);
}

export function parseDaemonJsonText(rawBody: string): JsonRecord | Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON body', code: 'INVALID_JSON', category: 'bad_request', status: 400 }, { status: 400 });
  }
  // Every handler reads the body as a record; null, an array, a string or a number would fail inside it as a 500.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Response.json({
      error: `The JSON body must be an object, not ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`}.`,
      code: 'INVALID_JSON',
      category: 'bad_request',
      status: 400,
    }, { status: 400 });
  }
  return parsed as JsonRecord;
}

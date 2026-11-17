import { redactSensitiveData } from '../../utils/redaction.js';
import { withheldFieldKind } from '../../utils/field-kind-reading.js';

/**
 * What the telemetry API's default (`safe`) view shows of a runtime event.
 *
 * Runtime event payloads are a fixed vocabulary (events/*.ts) and name their
 * fields consistently, so which fields hold conversation or work content is a
 * table by field name, read here once for every event type: a prompt, a
 * streamed chunk, a tool's arguments or output, a message body. Those are
 * withheld. Everything else (tool, provider, model, ids, statuses, counts,
 * durations, and error text) is what an operator needs to see why something
 * failed, so it is shown with credential-shaped text masked and paths
 * anonymised. Credential and owner-profile fields are withheld whole. Local and
 * deterministic: no model request, and the same record reads the same on every
 * call.
 *
 * A span attribute is judged by the last segment of its dotted name
 * (`tool.args` is `args`).
 */
const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  'prompt', 'content', 'accumulated', 'output', 'args', 'arguments', 'input', 'text', 'body', 'response',
  'reasoning', 'reasoningcontent', 'reasoningsummary', 'result', 'results', 'stdout', 'stderr', 'messages',
  'instructions', 'transcript', 'preview', 'snippet', 'diff', 'patch', 'excerpt', 'task', 'question', 'answer',
  'context', 'document', 'query', 'toolinput', 'tooloutput', 'completion', 'delta',
]);

const WITHHELD_TEXT = '[REDACTED_TEXT]';

function fieldName(key: string): string {
  const lastSegment = key.slice(key.lastIndexOf('.') + 1);
  return lastSegment.replace(/[_-]/g, '').toLowerCase();
}

/** Whether a payload or span attribute field carries content the safe view withholds. */
export function isTelemetryContentField(key: string): boolean {
  return CONTENT_FIELDS.has(fieldName(key));
}

/** Free text an operator reads (an error, a reason, a status), with credential-shaped spans masked. */
export function safeTelemetryText(text: string): string {
  return text.length === 0 ? text : redactSensitiveData(text);
}

function safeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return safeTelemetryText(value);
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => safeValue(item, seen));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const withheld = withheldFieldKind(fieldName(key));
      if (withheld === 'secret') {
        result[key] = child === null || child === undefined || typeof child === 'boolean' || child === '' ? child : '[REDACTED]';
      } else if (withheld === 'owner_profile') {
        result[key] = '[REDACTED_PROFILE]';
      } else if (isTelemetryContentField(key)) {
        result[key] = child === null || child === undefined || child === '' || typeof child === 'number' || typeof child === 'boolean'
          ? child
          : WITHHELD_TEXT;
      } else {
        result[key] = safeValue(child, seen);
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** The safe view of an event payload or a span's attributes. */
export function projectSafeTelemetryValue(value: unknown): unknown {
  return safeValue(value, new WeakSet());
}

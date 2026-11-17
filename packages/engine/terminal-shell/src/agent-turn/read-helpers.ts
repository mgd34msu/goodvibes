import { previewHarnessText } from './preview-text.js';

/** A positive count no larger than `max`; anything that is not a finite number takes the fallback. */
export function clampReadLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

/** Pattern redaction for text a read model published; it bounds what reaches the model, it does not authenticate it. */
export function redactReadModelText(value: string): string {
  return value
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^,\s;/]+/gi, '$1=<redacted>');
}

export function safePreview(value: string, limit: number): string {
  return previewHarnessText(redactReadModelText(value), limit);
}

export function safeNullablePreview(value: string, limit: number): string | null {
  return value ? safePreview(value, limit) : null;
}

function readTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** The record and the nested objects a publisher may put its certification fields in. */
export function certificationRecords(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  return [
    record,
    readObject(record.metadata),
    readObject(record.schema),
    readObject(record.contract),
    readObject(record.publication),
    readObject(record.receipt),
    readObject(record.certification),
  ];
}

export function firstAcross(records: readonly Record<string, unknown>[], keys: readonly string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = readTrimmed(record[key]);
      if (value) return value;
    }
  }
  return '';
}

export function stringList(value: unknown, cap: number): readonly string[] {
  if (Array.isArray(value)) return [...new Set(value.map(readTrimmed).filter(Boolean))].slice(0, cap);
  const text = readTrimmed(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, cap) : [];
}

const PUBLISHED_ROUTE_LIMIT = 240;
// The call grammar the Agent's own tools use: tool name, then key:value arguments. Shell-like tools (terminal,
// process, execution) are deliberately absent: a published text never gets to point a model at them.
const ROUTE_GRAMMAR = /^(research|autonomy|workspace|computer|audit|browser|channels|context|delegation|device|host|memory|models|occasions|personal_ops|profile|route|schedule|security|sessions|setup|support|vibe|agent_[a-z0-9_]+) [A-Za-z]+:/;

/** A route a read model published is offered to the model as something to run, so it must look like a call to one of the
 * Agent's tools and fit on one line. Anything else is treated as not published; the caller falls back to its own route. */
export function publishedModelRoute(raw: string): string {
  const route = raw.trim();
  if (!route || route.length > PUBLISHED_ROUTE_LIMIT || /[\r\n]/.test(route) || !ROUTE_GRAMMAR.test(route)) return '';
  return redactReadModelText(route);
}

import { assertJudgmentInput, captureOwnedJson, JudgmentInputError } from './judgment-input.js';

/** Replaces text the privacy screen refuses; the structured fields still decide. */
const WITHHELD = '[withheld]';

/**
 * The failure fields the transience reader and the summary use (`name`,
 * `message`, `code`, `status`, `statusCode`, `retryAfterMs` and the `cause`
 * chain), privacy-screened for a reading. Never throws for an Error: a field
 * it cannot read is left out, and text the screen refuses becomes
 * "[withheld]" so the status, code and error class can still decide.
 */
export function captureJudgmentFailureInput(input: unknown): unknown {
  return captureFailure(input, true);
}

/** The same fields for local use only (no privacy screen); screen before any transmission. */
export function captureFailureSnapshot(input: unknown): unknown {
  return captureFailure(input, false);
}

function read(object: object, key: string): unknown {
  try { return (object as Record<string, unknown>)[key]; } catch { return undefined; }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'bigint' ? String(value) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function passesScreen(value: unknown): boolean {
  try { assertJudgmentInput(value); return true; }
  catch (error) {
    if (error instanceof JudgmentInputError) return false;
    throw error;
  }
}

/** Plain data with every refused text field replaced; a field is screened with its name so declared credential fields stay refused. */
function withheld(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(item => withheld(item, key)));
  if (value && typeof value === 'object') {
    const copy = Object.create(null) as Record<string, unknown>;
    for (const [childKey, child] of Object.entries(value)) copy[childKey] = withheld(child, childKey);
    return Object.freeze(copy);
  }
  if (typeof value !== 'string') return value;
  return passesScreen(key === undefined ? value : { [key]: value }) ? value : WITHHELD;
}

function captureFailure(input: unknown, screen: boolean): unknown {
  const visiting = new Set<object>();
  const plain = (value: unknown): unknown => {
    let snapshot: unknown;
    try { snapshot = captureOwnedJson(typeof value === 'bigint' || typeof value === 'symbol' ? String(value) : value); }
    catch (error) {
      if (!(error instanceof JudgmentInputError)) throw error;
      // A thrown value that is not plain data (a class instance, a cycle) is described, not refused.
      let described: string;
      try { described = String(value); } catch { described = 'an unreadable failure value'; }
      snapshot = described;
    }
    return screen && !passesScreen(snapshot) ? withheld(snapshot) : snapshot;
  };
  const capture = (value: unknown, depth: number): unknown => {
    if (!(value instanceof Error)) return plain(value);
    if (depth > 16 || visiting.has(value)) return undefined;
    visiting.add(value);
    try {
      const screened = (field: string | undefined, fallback: string | undefined) =>
        field === undefined || !screen || passesScreen(field) ? field : fallback;
      const message = screened(text(read(value, 'message')) ?? '', WITHHELD) ?? '';
      const name = screened(text(read(value, 'name')), undefined) ?? 'Error';
      const code = screened(text(read(value, 'code')), undefined);
      let cause: unknown;
      try { cause = capture(read(value, 'cause'), depth + 1); } catch { cause = undefined; }
      const snapshot = cause === undefined ? new Error(message) : new Error(message, { cause });
      const facts: Record<string, unknown> = { name };
      if (code !== undefined) facts.code = code;
      for (const key of ['status', 'statusCode', 'retryAfterMs'] as const) {
        const number = finite(read(value, key));
        if (number !== undefined) facts[key] = number;
      }
      Object.assign(snapshot, facts);
      return Object.freeze(snapshot);
    } finally { visiting.delete(value); }
  };
  return capture(input, 0);
}

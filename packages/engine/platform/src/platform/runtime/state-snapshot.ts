/**
 * state-snapshot.ts, a read of the runtime store for debugging: what the
 * session, conversation, agents, tasks, permissions and the other domains hold
 * right now, as plain JSON.
 *
 * One reader serves both the daemon's `runtime.state.get` operator method and
 * the terminal apps' `/state` view, so an agent and a person see the same
 * shape. The value is made safe on the way out, not trusted to be:
 *   - JSON-safe: a Date is ISO text, an Error is `{ name, message }`, a bigint
 *     is decimal text, binary data is `"<N bytes>"`, a Map is an object of its
 *     entries, a Set an array, functions and symbols are left out;
 *   - credential-masked: a credential-named field reads `[REDACTED]`, an
 *     owner-profile field `[REDACTED_PROFILE]`, and credential-shaped text in
 *     any string is masked;
 *   - bounded: nesting stops at {@link STATE_SNAPSHOT_MAX_DEPTH} and the whole
 *     read at {@link STATE_SNAPSHOT_MAX_NODES} values, each cut marked
 *     `"[Truncated]"`; a value already on the current path reads `"[Circular]"`.
 *
 * Cost: paid only when a snapshot is asked for; nothing runs per request.
 */
import { redactSensitiveData } from '../utils/redaction.js';
import { withheldFieldKind } from '../utils/field-kind-reading.js';

/** How deep a domain's value is followed before it is cut. */
export const STATE_SNAPSHOT_MAX_DEPTH = 8;
/** How many values one snapshot holds at most, across every domain. */
export const STATE_SNAPSHOT_MAX_NODES = 20_000;

const TRUNCATED = '[Truncated]';

export interface RuntimeStateSnapshot {
  /** Epoch ms the store was read. */
  readonly capturedAt: number;
  /** The domains read, by name. */
  readonly domains: Readonly<Record<string, unknown>>;
  /** Every domain the store holds, so a caller knows what it can ask for. */
  readonly available: readonly string[];
  /** Domains asked for that the store does not hold. */
  readonly unknown: readonly string[];
  /** True when a depth or size bound cut something; the cut values read `"[Truncated]"`. */
  readonly truncated: boolean;
}

interface Budget {
  nodes: number;
  truncated: boolean;
}

function fieldName(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function isBinary(value: object): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function safeValue(value: unknown, depth: number, path: WeakSet<object>, budget: Budget): unknown {
  if (budget.nodes >= STATE_SNAPSHOT_MAX_NODES) {
    budget.truncated = true;
    return TRUNCATED;
  }
  budget.nodes += 1;
  switch (typeof value) {
    case 'string':
      return value.length === 0 ? value : redactSensitiveData(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (value === null) return null;
  const object = value as object;
  if (object instanceof Date) return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  if (object instanceof Error) return { name: object.name, message: redactSensitiveData(object.message) };
  if (isBinary(object)) return `<${object.byteLength} bytes>`;
  if (depth >= STATE_SNAPSHOT_MAX_DEPTH) {
    budget.truncated = true;
    return TRUNCATED;
  }
  if (path.has(object)) return '[Circular]';
  path.add(object);
  try {
    if (Array.isArray(object) || object instanceof Set) {
      const out: unknown[] = [];
      for (const item of object) {
        const safe = safeValue(item, depth + 1, path, budget);
        out.push(safe === undefined ? null : safe);
        if (budget.nodes >= STATE_SNAPSHOT_MAX_NODES) break;
      }
      return out;
    }
    const entries: Iterable<readonly [unknown, unknown]> = object instanceof Map
      ? object.entries()
      : Object.entries(object as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [rawKey, child] of entries) {
      const key = String(rawKey);
      const withheld = withheldFieldKind(fieldName(key));
      if (withheld === 'secret') {
        out[key] = child === null || child === undefined || child === '' || typeof child === 'boolean' ? child : '[REDACTED]';
      } else if (withheld === 'owner_profile') {
        out[key] = '[REDACTED_PROFILE]';
      } else {
        const safe = safeValue(child, depth + 1, path, budget);
        if (safe !== undefined) out[key] = safe;
      }
      if (budget.nodes >= STATE_SNAPSHOT_MAX_NODES) break;
    }
    return out;
  } finally {
    path.delete(object);
  }
}

/**
 * Read the runtime store's domains (all of them, or the ones named) as a
 * JSON-safe, credential-masked, bounded snapshot.
 */
export function snapshotRuntimeState(
  store: { getState(): object },
  options: { readonly domains?: readonly string[] | undefined } = {},
): RuntimeStateSnapshot {
  const capturedAt = Date.now();
  const state = store.getState() as Record<string, unknown>;
  const available = Object.keys(state).sort();
  const asked = options.domains && options.domains.length > 0 ? [...new Set(options.domains)] : available;
  const unknown = asked.filter((domain) => !Object.hasOwn(state, domain));
  const budget: Budget = { nodes: 0, truncated: false };
  const domains: Record<string, unknown> = {};
  for (const domain of asked) {
    if (!Object.hasOwn(state, domain)) continue;
    const safe = safeValue(state[domain], 0, new WeakSet(), budget);
    domains[domain] = safe === undefined ? null : safe;
  }
  return { capturedAt, domains, available, unknown, truncated: budget.truncated };
}

/** A snapshot as lines a terminal prints: one JSON block per domain, then what was cut or not found. */
export function formatRuntimeStateSnapshot(snapshot: RuntimeStateSnapshot, heading: string): string {
  const lines = [heading];
  for (const [domain, value] of Object.entries(snapshot.domains)) {
    lines.push(`${domain}:`, ...JSON.stringify(value, null, 2).split('\n').map((line) => `  ${line}`));
  }
  if (snapshot.unknown.length > 0) {
    lines.push(`No such domain: ${snapshot.unknown.join(', ')}. Domains: ${snapshot.available.join(', ')}.`);
  }
  if (snapshot.truncated) {
    lines.push(`Some values were cut ("${TRUNCATED}"): name fewer domains to see more.`);
  }
  return lines.join('\n');
}

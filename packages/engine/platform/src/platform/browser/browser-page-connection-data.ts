/** Serialized native browser observations, not browser or payment authority. */
import { captureOwnedJson } from '../gate/judgment-input.js';
import { debuggerWebSocket } from './browser-cdp.js';

export interface BrowserPageConnection {
  readonly version: 1;
  /** Original discovered browser WebSocket. Private; never include in status. */
  readonly endpoint: string;
  readonly targetId: string;
  readonly browserContextId: string | null;
  readonly frames: readonly {
    readonly id: string;
    readonly loaderId: string;
    readonly parentId: string | null;
  }[];
}
export class BrowserPageConnectionError extends Error {
  override readonly name = 'BrowserPageConnectionError';
  constructor() { super('The original browser page connection is unavailable.'); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

/** Decode only observations. Even a well-formed record must be rebound to the
 * actually retained paired grant, browser endpoint, page and controls before use. */
export function captureBrowserPageConnection(value: unknown): BrowserPageConnection {
  try {
    const row = captureOwnedJson(value);
    if (!object(row) || !keys(row, ['version', 'endpoint', 'targetId', 'browserContextId', 'frames']) || row['version'] !== 1
      || typeof row['endpoint'] !== 'string' || row['endpoint'].length > 16_384 || !debuggerWebSocket(row['endpoint'])
      || !id(row['targetId']) || row['browserContextId'] !== null && !id(row['browserContextId'])
      || !Array.isArray(row['frames']) || row['frames'].length === 0 || row['frames'].length > 4096) throw new BrowserPageConnectionError();
    const frames: Array<BrowserPageConnection['frames'][number]> = [];
    const ids = new Set<string>(), children = new Map<string | null, string[]>();
    for (const frame of row['frames']) {
      if (!object(frame) || !keys(frame, ['id', 'loaderId', 'parentId']) || !id(frame['id']) || !id(frame['loaderId'])
        || frame['parentId'] !== null && !id(frame['parentId']) || ids.has(frame['id'])) throw new BrowserPageConnectionError();
      ids.add(frame['id']);
      const parentId = frame['parentId'] as string | null;
      const siblings = children.get(parentId) ?? []; siblings.push(frame['id']); children.set(parentId, siblings);
      frames.push(Object.freeze({ id: frame['id'], loaderId: frame['loaderId'], parentId }));
    }
    const roots = children.get(null);
    if (!roots || roots.length !== 1) throw new BrowserPageConnectionError();
    const pending = [...roots], reached = new Set<string>();
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined || reached.has(next)) throw new BrowserPageConnectionError();
      reached.add(next);
      for (const child of children.get(next) ?? []) pending.push(child);
    }
    if (reached.size !== ids.size) throw new BrowserPageConnectionError();
    frames.sort((a, b) => a.id.localeCompare(b.id));
    return Object.freeze({ version: 1, endpoint: row['endpoint'], targetId: row['targetId'],
      browserContextId: row['browserContextId'] as string | null, frames: Object.freeze(frames) });
  } catch { throw new BrowserPageConnectionError(); }
}

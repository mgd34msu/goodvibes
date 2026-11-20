/**
 * personal-ops-data.ts, the plain-data capture and JSON grammar every Agent
 * reading uses before a value is handed to a decision: hidden producer fields
 * are kept, a value is copied once within node and character budgets, and an
 * entry never has a bare number or boolean at its root.
 */
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools';
import type { EntryType, JsonValue } from '@goodvibes/judgment/decisions';
import { captureCatalogData } from './catalog-data.js';

/** Hidden producer data is still semantic source; serialization cannot omit it. */
export function capturePersonalOpsData(value: unknown): unknown {
  const captured = captureCatalogData(value);
  let nodes = 0, characters = 0;
  const visit = (entry: unknown): unknown => {
    if (++nodes > 20_000) throw new ToolInputProjectionError('invalid');
    if (typeof entry === 'string') { characters += entry.length; if (characters > 1_000_000) throw new ToolInputProjectionError('invalid'); }
    if (!entry || typeof entry !== 'object') return entry;
    const names = Object.getOwnPropertyNames(entry);
    if (Array.isArray(entry)) {
      // A captured array carries its indices and `length`, nothing else.
      if (names.length !== entry.length + 1) throw new ToolInputProjectionError('invalid');
      return entry.map(visit);
    }
    const record = entry as Record<string, unknown>;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of names) {
      characters += key.length; if (characters > 1_000_000) throw new ToolInputProjectionError('invalid');
      Object.defineProperty(result, key, { value: visit(record[key]), enumerable: true });
    }
    return result;
  };
  return visit(captured);
}

/** JSON normalization follows serialization grammar after the plain-data capture. */
export function personalOpsJson(value: unknown): JsonValue {
  const captured = capturePersonalOpsData(value);
  const visit = (entry: unknown): JsonValue => {
    if (entry === undefined || entry === null) return null;
    if (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry !== 'object') throw new ToolInputProjectionError('invalid');
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, child] of Object.entries(entry)) {
      if (child === undefined) continue;
      Object.defineProperty(result, key, { value: visit(child), enumerable: true });
    }
    return result;
  };
  return visit(captured);
}

/** Entry grammar excludes bare numeric and boolean roots. */
export function personalOpsEntry(value: unknown): EntryType {
  const entry = personalOpsJson(value);
  return typeof entry === 'boolean' || typeof entry === 'number' ? { value: entry } : entry;
}

/**
 * The state tool's `mode=memory` records. A memory key is one row in the
 * project memory store (tagged `state-memory:<key>`, the value in `detail`),
 * the same row prompt retrieval reads, so what `get` and `list` show is what
 * the model is given later. The store is reached through the memory spine
 * when the host has one, so a process whose memory is served by a connected
 * host writes to that host, and a write that cannot reach the store fails.
 *
 * A saved row is tagged `classification-pending` and the call returns; its
 * memory class is read afterwards, off the call's path, and the row is
 * refiled when the reading settles. An unsure, late or unavailable reading
 * leaves the row pending for review; it never loses the memory or delays it.
 */
import { readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { isClassicOperation } from '../../runtime/decision-policy.js';
import { judge } from '../../runtime/judge.js';
import type { MemoryAccess } from '../../runtime/memory-spine/client.js';
import type { MemoryClass, MemoryRecord } from '../../state/memory-store.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { MAX_JUDGED_MEMORY_CHARS, memoryClass, memoryClassView } from '../batteries/memory-class.js';

const MEMORY_CLASS_SITE = 'tools.state.memory-class';
const KEY_TAG = 'state-memory';
const PENDING_TAG = 'classification-pending';
const CLASSIC_TAG = 'classic-memory';

/** The memory store operations the state tool uses: the memory spine, or a local registry behind `createLocalMemoryAccess`. */
export type StateMemoryStore = Pick<MemoryAccess, 'add' | 'list' | 'update' | 'updateReview' | 'delete' | 'get'>;

/** Classifications started after a write that have not settled yet. */
const classifying = new Set<Promise<void>>();

/** Resolves when every classification started so far has settled (an orderly shutdown, or a caller that needs the filed class). */
export async function memoryClassificationsSettled(): Promise<void> {
  while (classifying.size > 0) await Promise.all([...classifying]);
}

function keyTag(key: string): string {
  return `${KEY_TAG}:${key}`;
}

/** The key a state-tool memory row is saved under, or undefined for any other row. */
export function memoryKeyOf(record: Pick<MemoryRecord, 'tags'>): string | undefined {
  const tag = record.tags.find((candidate) => candidate.startsWith(`${KEY_TAG}:`));
  return tag?.slice(KEY_TAG.length + 1);
}

/** Every state-tool memory row, one per key (the newest when an older build left two). */
export async function listMemoryRecords(store: StateMemoryStore, signal?: AbortSignal): Promise<Map<string, MemoryRecord>> {
  const rows = await store.list({ tags: [KEY_TAG] }, signal ? { signal } : undefined);
  const byKey = new Map<string, MemoryRecord>();
  for (const row of rows) {
    const key = memoryKeyOf(row);
    if (!key) continue;
    const kept = byKey.get(key);
    if (!kept || row.updatedAt > kept.updatedAt) byKey.set(key, row);
  }
  return byKey;
}

/** The rows saved under one key (normally one). */
export async function memoryRecordsForKey(store: StateMemoryStore, key: string, signal?: AbortSignal): Promise<readonly MemoryRecord[]> {
  return store.list({ tags: [keyTag(key)] }, signal ? { signal } : undefined);
}

/** Why a value cannot be saved as a memory (it would be embedded and may be sent), or undefined when it can. */
export function memoryValueRefusal(key: string, value: string): string | undefined {
  try {
    assertJudgmentInput({ key, value });
    return undefined;
  } catch (error) {
    if (error instanceof JudgmentInputError) {
      return 'the value looks like it holds a credential or private material, and a memory is embedded and may be sent to a model. Keep secrets in the secret store and save a description instead';
    }
    throw error;
  }
}

/**
 * Saves `value` under `key`: updates the key's row (resetting its review) or
 * adds one. Throws when the store cannot be reached; nothing is reported saved
 * that was not.
 */
export async function saveMemoryRecord(store: StateMemoryStore, key: string, value: string, signal?: AbortSignal): Promise<MemoryRecord> {
  const classic = isClassicOperation();
  const operation = signal ? { signal } : undefined;
  const existing = (await memoryRecordsForKey(store, key, signal))[0];
  const tags = [...(existing?.tags ?? [KEY_TAG, keyTag(key)]).filter((tag) => tag !== PENDING_TAG && tag !== CLASSIC_TAG),
    PENDING_TAG, ...(classic ? [CLASSIC_TAG] : [])];
  const flat = value.replace(/\s+/g, ' ').trim();
  const summary = flat.length > 160 ? `${flat.slice(0, 157)}...` : (flat || key);
  let saved: MemoryRecord | null;
  if (existing) {
    saved = await store.update(existing.id, { summary, detail: value, tags }, operation);
    if (!saved) throw new Error(`the memory row for ${key} disappeared while it was being updated; save it again`);
    // A corrected value is a new statement: a row marked stale or contradicted would otherwise stay out of prompts.
    if (saved.reviewState !== 'fresh') saved = await store.updateReview(saved.id, { state: 'fresh' }, operation) ?? saved;
  } else {
    saved = await store.add({ scope: 'project', cls: 'fact', summary, detail: value, tags, review: { state: 'fresh' } }, operation);
  }
  if (!classic) classifyLater(store, saved.id, key, value);
  return saved;
}

/**
 * Brings memories an earlier build kept as `<key>.json` files in `dir` into the
 * store: a file whose key has no row is saved as one, and every file read is
 * renamed to `<key>.json.imported` so it is kept and never read again. A value
 * that cannot be saved (the store refuses it, or it holds a credential) keeps
 * its file for the next start. Returns the keys brought in.
 */
export async function importMemoryFiles(store: StateMemoryStore, dir: string, signal?: AbortSignal): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name));
  } catch {
    return [];
  }
  if (names.length === 0) return [];
  const present = await listMemoryRecords(store, signal);
  const imported: string[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const key = name.slice(0, -'.json'.length);
    const path = join(dir, name);
    try {
      if (!present.has(key)) {
        const value = await readFile(path, 'utf-8');
        if (memoryValueRefusal(key, value)) continue;
        await saveMemoryRecord(store, key, value, signal);
        imported.push(key);
      }
      await rename(path, `${path}.imported`);
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn('state tool: a memory file from an earlier build was not brought into the memory store; it is kept', { key, error: summarizeError(error) });
    }
  }
  return imported;
}

/**
 * Reads the record's class with `engine.tools.memory-class` and refiles it when the reading acts,
 * provided the record still holds the value that was read (a later write of the key reads its own).
 */
function classifyLater(store: StateMemoryStore, id: string, key: string, value: string): void {
  // A value longer than one reading carries stays pending for review.
  if (value.length > MAX_JUDGED_MEMORY_CHARS) return;
  const work = (async () => {
    const { value: cls } = await judge<typeof memoryClass.items, MemoryClass | undefined>({
      site: MEMORY_CLASS_SITE,
      battery: memoryClass,
      state: memoryClassView(key, value),
      settle: ({ memory_class: reading }) => reading.outcome === 'act' ? reading.choice : undefined,
      fallback: () => undefined,
      describe: (settled) => `filed as ${settled}`,
    });
    if (cls === undefined) return;
    const record = await store.get(id);
    if (!record || record.detail !== value || record.cls === cls) {
      if (record?.detail === value) await store.update(id, { tags: record.tags.filter((tag) => tag !== PENDING_TAG) });
      return;
    }
    // The store's update has no class field, so the row is saved again under its class and the pending copy goes.
    const filed = await store.add({
      scope: record.scope, cls, summary: record.summary, detail: value,
      tags: record.tags.filter((tag) => tag !== PENDING_TAG), review: { state: 'fresh' },
    });
    const still = await store.get(id);
    // A write of the key while the class was read wins: the filed copy is the stale one then.
    await store.delete(still?.detail === value ? id : filed.id);
  })().catch((error: unknown) => {
    logger.debug('state tool: memory class not read; the record stays pending review', { key, error: summarizeError(error) });
  });
  classifying.add(work);
  void work.finally(() => classifying.delete(work));
}

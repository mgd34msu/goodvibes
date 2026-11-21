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
 *
 * Only memory records are read and written here; no file is.
 */
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

/**
 * True when `row` is the current row of its key over `other`: the newer `updatedAt`, then the lower
 * id, so every process picks the same row of a key that holds two.
 */
function isCurrentOver(row: MemoryRecord, other: MemoryRecord): boolean {
  return row.updatedAt !== other.updatedAt ? row.updatedAt > other.updatedAt : row.id < other.id;
}

/** The current row among one key's rows, or undefined when there are none. */
function currentOf(rows: readonly MemoryRecord[]): MemoryRecord | undefined {
  let current: MemoryRecord | undefined;
  for (const row of rows) if (!current || isCurrentOver(row, current)) current = row;
  return current;
}

/** Every state-tool memory row, one per key: the current row when a key holds two. */
export async function listMemoryRecords(store: StateMemoryStore, signal?: AbortSignal): Promise<Map<string, MemoryRecord>> {
  const rows = await store.list({ tags: [KEY_TAG] }, signal ? { signal } : undefined);
  const byKey = new Map<string, MemoryRecord>();
  for (const row of rows) {
    const key = memoryKeyOf(row);
    if (!key) continue;
    const kept = byKey.get(key);
    if (!kept || isCurrentOver(row, kept)) byKey.set(key, row);
  }
  return byKey;
}

/** The rows saved under one key (normally one). */
export async function memoryRecordsForKey(store: StateMemoryStore, key: string, signal?: AbortSignal): Promise<readonly MemoryRecord[]> {
  return store.list({ tags: [keyTag(key)] }, signal ? { signal } : undefined);
}

/** The key's current row (the one `list` shows), or undefined when the key has none. */
export async function currentMemoryRecord(store: StateMemoryStore, key: string, signal?: AbortSignal): Promise<MemoryRecord | undefined> {
  return currentOf(await memoryRecordsForKey(store, key, signal));
}

/** Deletes every row of the key but the current one, so duplicate rows converge on the same row in every process. */
async function deleteSupersededRows(store: StateMemoryStore, rows: readonly MemoryRecord[], signal?: AbortSignal): Promise<void> {
  const current = currentOf(rows);
  for (const row of rows) {
    if (row.id !== current?.id) await store.delete(row.id, signal ? { signal } : undefined);
  }
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
 * Saves `value` under `key`: updates the key's current row (resetting its
 * review) or adds one, then deletes any other row of the key, so a key left
 * with two rows (an older build, or two processes adding it at once) ends with
 * one. Throws when the store cannot be reached; nothing is reported saved
 * that was not. Cost: one more list when the key is added, and a delete only
 * when the key held more than one row.
 */
export async function saveMemoryRecord(store: StateMemoryStore, key: string, value: string, signal?: AbortSignal): Promise<MemoryRecord> {
  const classic = isClassicOperation();
  const operation = signal ? { signal } : undefined;
  const before = await memoryRecordsForKey(store, key, signal);
  const existing = currentOf(before);
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
    // The key's current row now holds the value; the other rows read before the write go.
    for (const row of before) {
      if (row.id !== existing.id) await store.delete(row.id, operation);
    }
  } else {
    saved = await store.add({ scope: 'project', cls: 'fact', summary, detail: value, tags, review: { state: 'fresh' } }, operation);
    // Another process may have added the key at the same moment: read again and keep the one current row.
    const after = await memoryRecordsForKey(store, key, signal);
    if (after.length > 1) await deleteSupersededRows(store, after, signal);
  }
  if (!classic) classifyLater(store, saved.id, key, value);
  return saved;
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

/**
 * The state tool's mirror of `mode=memory action=set` writes into the
 * retrievable memory store, and the reading that files a mirrored record under
 * its memory class.
 *
 * The flat file is written first and is the source of truth. The mirror row is
 * then written at once tagged `classification-pending`, and the tool call
 * returns; the class is read afterwards, off the call's path, and the row is
 * refiled when the reading settles. An unsure, late or unavailable reading
 * leaves the row pending for review; it never loses the memory or delays it.
 */
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { isClassicOperation } from '../../runtime/decision-policy.js';
import { judge } from '../../runtime/judge.js';
import type { MemoryRegistry } from '../../state/memory-registry.js';
import type { MemoryClass, ProvenanceLink } from '../../state/memory-store.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { MAX_JUDGED_MEMORY_CHARS, memoryClass, memoryClassView } from '../batteries/memory-class.js';

const MEMORY_CLASS_SITE = 'tools.state.memory-class';
const PENDING_TAG = 'classification-pending';
const CLASSIC_TAG = 'classic-memory';

/** Classifications started after a write that have not settled yet. */
const classifying = new Set<Promise<void>>();

/** Resolves when every classification started so far has settled (an orderly shutdown, or a caller that needs the filed class). */
export async function memoryClassificationsSettled(): Promise<void> {
  while (classifying.size > 0) await Promise.all([...classifying]);
}

/** What the mirror of one write did. */
export interface MemoryMirrorResult {
  /** A retrievable record holds the new value. */
  readonly indexed: boolean;
  /** `pending` while the class is read after the write; `not-indexed` when nothing was mirrored. */
  readonly classification: 'pending' | 'not-indexed';
}

/**
 * Mirror a `mode=memory action=set` write into a retrievable `memory_records` row so passive
 * per-turn knowledge injection (which only reads `memory_records`, never the flat
 * `.goodvibes/memory/*.json` files) can surface it.
 *
 * Deduped per key via a stable `state-memory:<key>` tag, so repeated statements of the same
 * preference UPDATE the single record instead of piling up duplicates. Provenance is a `file` link
 * back to the flat-file twin. The record enters at reviewState 'fresh' with default confidence,
 * visible to retrieval but not stamped reviewed, so a self-recorded preference cannot inject itself
 * at unearned trust.
 *
 * Call after the flat file is written. A value the transmission check refuses stays in the flat
 * file only (a mirror may be embedded and sent). A registry failure never fails the caller's write.
 */
export async function mirrorMemoryRecord(
  memoryRegistry: MemoryRegistry | undefined,
  safeKey: string,
  value: string,
): Promise<MemoryMirrorResult> {
  const notIndexed: MemoryMirrorResult = { indexed: false, classification: 'not-indexed' };
  if (!memoryRegistry) return notIndexed;
  try { assertJudgmentInput({ key: safeKey, value }); }
  catch (error) { if (error instanceof JudgmentInputError) return notIndexed; throw error; }
  const classic = isClassicOperation();
  try {
    const existing = memoryRegistry.getAll().find((record) => record.tags.includes(`state-memory:${safeKey}`));
    const tags = [...(existing?.tags ?? ['state-memory', `state-memory:${safeKey}`]).filter((tag) => tag !== PENDING_TAG && tag !== CLASSIC_TAG),
      PENDING_TAG, ...(classic ? [CLASSIC_TAG] : [])];
    const flat = value.replace(/\s+/g, ' ').trim();
    const summary = flat.length > 160 ? `${flat.slice(0, 157)}...` : (flat || safeKey);
    let id: string;
    if (existing) {
      const updated = memoryRegistry.update(existing.id, { summary, detail: value, resetReview: true, tags });
      if (!updated) return notIndexed;
      id = updated.id;
    } else {
      const provenance: ProvenanceLink[] = [
        { kind: 'file', ref: `.goodvibes/memory/${safeKey}.json`, label: `state tool memory (${safeKey})` },
      ];
      id = (await memoryRegistry.add({ scope: 'project', cls: 'fact', summary, detail: value, tags, provenance, review: { state: 'fresh' } })).id;
    }
    if (!classic) classifyLater(memoryRegistry, id, safeKey, value);
    return { indexed: true, classification: 'pending' };
  } catch (err) {
    logger.warn('state tool: memory record mirror failed (flat-file write unaffected)', { key: safeKey, error: summarizeError(err) });
    return notIndexed;
  }
}

/**
 * Reads the record's class with `engine.tools.memory-class` and refiles it when the reading acts,
 * provided the record still holds the value that was read (a later write of the key reads its own).
 */
function classifyLater(memoryRegistry: MemoryRegistry, id: string, safeKey: string, value: string): void {
  // A value longer than one reading carries stays pending for review.
  if (value.length > MAX_JUDGED_MEMORY_CHARS) return;
  const work = (async () => {
    const { value: cls } = await judge<typeof memoryClass.items, MemoryClass | undefined>({
      site: MEMORY_CLASS_SITE,
      battery: memoryClass,
      state: memoryClassView(safeKey, value),
      settle: ({ memory_class: reading }) => reading.outcome === 'act' ? reading.choice : undefined,
      fallback: () => undefined,
      describe: (settled) => `filed as ${settled}`,
    });
    if (cls === undefined) return;
    const record = memoryRegistry.get(id);
    if (!record || record.detail !== value) return;
    memoryRegistry.update(id, { cls, tags: record.tags.filter((tag) => tag !== PENDING_TAG) });
  })().catch((error: unknown) => {
    logger.debug('state tool: memory class not read; the record stays pending review', { key: safeKey, error: summarizeError(error) });
  });
  classifying.add(work);
  void work.finally(() => classifying.delete(work));
}

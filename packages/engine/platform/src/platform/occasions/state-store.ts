/**
 * state-store.ts, everything the MACHINE knows about occasions.
 *
 * The split this file exists for: an occasion declaration is a durable fact
 * about the owner's life, so it lives in their profile where they can
 * hand-edit it. "Asked on the 3rd, they said no" is machine-written
 * bookkeeping, and the profile design's whole guarantee is that nothing
 * rewrites a line they wrote. Putting
 * acknowledgement state in that file would break the guarantee to save one file,
 * so it does not go there. It goes here.
 *
 * ── The persisted-state treatment, in full ────────────────────────────────
 *
 * Anything persisted across restarts reaps, bounds, validates by content, sweeps
 * periodically, and discloses. All five, not four:
 *
 *  - **Bounded.** Every collection has a cap and the oldest go first, so a
 *    long-lived daemon cannot grow this file without limit.
 *  - **Validated by content.** Records are checked one at a time and a bad one
 *    is DROPPED AND COUNTED rather than throwing the file away. A single
 *    malformed record must not cost the owner a decade of gift history.
 *  - **Reaped on schedule.** An answer dies with its occurrence, which is what
 *    makes "declining goes silent until the date passes, then asks fresh next
 *    year" a property of the data rather than a rule someone must remember.
 *  - **Swept.** {@link OccasionStateStore.sweep} drops orphans, state whose
 *    occasion is no longer declared, and ages out gift history past its
 *    retention.
 *  - **Discloses.** {@link OccasionStateStore.disclose} says what it is holding
 *    and what the last sweep removed, including whether the file was found
 *    unreadable.
 *
 * ── Write ordering ────────────────────────────────────────────────────────
 *
 * Every write goes through a {@link StoreWriteQueue}. `PersistentStore.persist`
 * is atomic and says nothing about ORDER, and this store has genuinely
 * concurrent writers: the sweep runs on a timer while an answer arrives over a
 * channel and an interview step lands from the agent. Unordered, the sweep's
 * snapshot, taken before the answer existed, can land second and put the file
 * back without it. The owner then gets asked again about something they
 * already answered, which is the exact failure the acknowledgement store was
 * built to
 * stop.
 */
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { captureFileMutation } from '../utils/file-mutation.js';
import { occasionStateReceipts } from './operation.js';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { noteListChanged } from '../runtime/list-changes.js';
import { logger } from '../utils/logger.js';
import { groupWorkShared, type GroupWorkLink } from '../cluster/group-work.js';
import type { AuthorityChange } from '../cluster/authority-record-file.js';
import { mergeOccasionSlices, occasionIdsOf, sliceIsEmpty, sliceJson, sliceOf, withSlice, type OccasionSlice } from './state-replica.js';
import { addDays, isIsoDate, type IsoDate } from './dates.js';
import {
  isOccasionAckSource,
  isOccasionAnswer,
  isRaiseBoundary,
  OCCASION_SUBJECTS,
  type GiftRecord,
  type Interview,
  type InterviewAnswer,
  type InterviewStep,
  type OccasionAcknowledgement,
  type OccasionAttribution,
  type OccasionMirrorRecord,
  type OccasionStateDisclosure,
  type OccasionSweepReport,
  type OpenItem,
  type OpenItemKind,
  type OccasionSubject,
  type RaiseBoundary,
} from './types.js';
import { occasionMirrorKey } from './sweep.js';

const UNRESTRICTED_OPERATION = () => {};

/** Caps. Generous against any real life, finite against an unbounded file. */
export const MAX_ACKNOWLEDGEMENTS = 2000;
export const MAX_GIFT_RECORDS = 2000;
export const MAX_OPEN_ITEMS = 500;
export const MAX_INTERVIEWS = 200;
export const MAX_MIRRORS = 2000;
export const MAX_ATTRIBUTIONS = 2000;

interface OccasionStateSnapshot extends Record<string, unknown> {
  version: 1;
  acknowledgements: OccasionAcknowledgement[];
  gifts: GiftRecord[];
  openItems: OpenItem[];
  interviews: Interview[];
  mirrors: OccasionMirrorRecord[];
  attributions: OccasionAttribution[];
  lastSweep: OccasionSweepReport | null;
}

function emptySnapshot(): OccasionStateSnapshot {
  return {
    version: 1,
    acknowledgements: [],
    gifts: [],
    openItems: [],
    interviews: [],
    mirrors: [],
    attributions: [],
    lastSweep: null,
  };
}

// ---------------------------------------------------------------------------
// Content validation, one record at a time
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validAcknowledgement(value: unknown): OccasionAcknowledgement | null {
  if (!isRecord(value)) return null;
  const occasionId = str(value['occasionId']);
  const occurrence = str(value['occurrence']);
  const answer = str(value['answer']);
  const answeredAt = num(value['answeredAt']);
  if (occasionId === null || occurrence === null || answer === null || answeredAt === null) return null;
  if (!isIsoDate(occurrence) || !isOccasionAnswer(answer)) return null;
  const expiresAfter = str(value['expiresAfter']);
  const returnOn = str(value['returnOn']);
  const source = str(value['source']);
  return {
    id: str(value['id']) ?? `${occasionId}@${occurrence}`,
    occasionId,
    occurrence,
    answer,
    answeredAt,
    // An unrecognised source is dropped and the ANSWER IS KEPT. The source
    // explains a mute; the answer is the mute. Losing the whole record over a
    // provenance label would start pushing at the owner again to punish a typo.
    ...(source !== null && isOccasionAckSource(source) ? { source } : {}),
    ...(expiresAfter !== null && isIsoDate(expiresAfter) ? { expiresAfter } : {}),
    ...(returnOn !== null && isIsoDate(returnOn) ? { returnOn } : {}),
  };
}

function validGift(value: unknown): GiftRecord | null {
  if (!isRecord(value)) return null;
  const occasionId = str(value['occasionId']);
  const occurrence = str(value['occurrence']);
  const landedOn = str(value['landedOn']);
  const recordedAt = num(value['recordedAt']);
  if (occasionId === null || occurrence === null || landedOn === null || recordedAt === null) return null;
  if (!isIsoDate(occurrence)) return null;
  const notes = str(value['notes']);
  return { occasionId, occurrence, landedOn, recordedAt, ...(notes === null ? {} : { notes }) };
}

const OPEN_ITEM_KINDS: readonly OpenItemKind[] = ['nudge', 'conflict', 'interview'];

function validOpenItem(value: unknown): OpenItem | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const kind = str(value['kind']);
  const occasionId = str(value['occasionId']);
  const dueOn = str(value['dueOn']);
  const openedAt = num(value['openedAt']);
  const lastRaisedAt = num(value['lastRaisedAt']);
  const raiseCount = num(value['raiseCount']);
  if (id === null || kind === null || occasionId === null || dueOn === null) return null;
  if (openedAt === null || lastRaisedAt === null || raiseCount === null) return null;
  if (!(OPEN_ITEM_KINDS as readonly string[]).includes(kind) || !isIsoDate(dueOn)) return null;
  const occurrence = typeof value['occurrence'] === 'string' ? value['occurrence'] : '';
  const expiresAfter = str(value['expiresAfter']);
  // The boundaries this item has been raised at, read as saved: an empty list
  // stays empty (the owner's "later" clears it), and nothing is inferred from
  // the raise count.
  const rawBoundaries = Array.isArray(value['servedBoundaries']) ? value['servedBoundaries'] : [];
  const servedBoundaries = [
    ...new Set(
      rawBoundaries.filter((entry): entry is RaiseBoundary =>
        typeof entry === 'string' && isRaiseBoundary(entry)),
    ),
  ];
  return {
    id,
    kind: kind as OpenItemKind,
    occasionId,
    occurrence,
    openedAt,
    lastRaisedAt,
    raiseCount,
    servedBoundaries,
    dueOn,
    ...(expiresAfter !== null && isIsoDate(expiresAfter) ? { expiresAfter } : {}),
  };
}

function validInterviewStep(value: unknown): InterviewStep | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const prompt = str(value['prompt']);
  if (id === null || prompt === null) return null;
  return { id, prompt, opensFrom: typeof value['opensFrom'] === 'string' ? value['opensFrom'] : '' };
}

function validInterviewAnswer(value: unknown): InterviewAnswer | null {
  if (!isRecord(value)) return null;
  const stepId = str(value['stepId']);
  const answeredAt = num(value['answeredAt']);
  if (stepId === null || answeredAt === null) return null;
  return { stepId, text: typeof value['text'] === 'string' ? value['text'] : '', answeredAt };
}

function validInterview(value: unknown): Interview | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const occasionId = str(value['occasionId']);
  const occurrence = str(value['occurrence']);
  const startedAt = num(value['startedAt']);
  if (id === null || occasionId === null || occurrence === null || startedAt === null) return null;
  if (!isIsoDate(occurrence)) return null;
  const rawSteps = Array.isArray(value['steps']) ? value['steps'] : [];
  const rawAnswers = Array.isArray(value['answers']) ? value['answers'] : [];
  const steps = rawSteps.map(validInterviewStep).filter((step): step is InterviewStep => step !== null);
  const answers = rawAnswers
    .map(validInterviewAnswer)
    .filter((answer): answer is InterviewAnswer => answer !== null);
  // An interview with no questions left cannot be resumed and is not a thread
  // the owner can be asked to continue, so it does not survive the read.
  if (steps.length === 0) return null;
  const landedOn = str(value['landedOn']);
  const completedAt = num(value['completedAt']);
  return {
    id,
    occasionId,
    occurrence,
    startedAt,
    steps,
    answers,
    ...(landedOn === null ? {} : { landedOn }),
    ...(completedAt === null ? {} : { completedAt }),
  };
}

function validMirror(value: unknown): OccasionMirrorRecord | null {
  if (!isRecord(value)) return null;
  const occasionId = str(value['occasionId']);
  const occurrence = str(value['occurrence']);
  const externalId = str(value['externalId']);
  const mirroredAt = num(value['mirroredAt']);
  if (occasionId === null || occurrence === null || externalId === null || mirroredAt === null) return null;
  if (!isIsoDate(occurrence)) return null;
  return { occasionId, occurrence, externalId, mirroredAt };
}

function validAttribution(value: unknown): OccasionAttribution | null {
  if (!isRecord(value)) return null;
  const occasionId = str(value['occasionId']);
  const key = str(value['key']);
  const subject = str(value['subject']);
  const readAt = num(value['readAt']);
  if (occasionId === null || key === null || subject === null || readAt === null) return null;
  if (!(OCCASION_SUBJECTS as readonly string[]).includes(subject)) return null;
  return { occasionId, key, subject: subject as OccasionSubject, readAt };
}

function validSweepReport(value: unknown): OccasionSweepReport | null {
  if (!isRecord(value)) return null;
  const sweptAt = num(value['sweptAt']);
  if (sweptAt === null) return null;
  return {
    sweptAt,
    expiredAcknowledgements: num(value['expiredAcknowledgements']) ?? 0,
    orphanedRecords: num(value['orphanedRecords']) ?? 0,
    expiredOpenItems: num(value['expiredOpenItems']) ?? 0,
    agedGiftRecords: num(value['agedGiftRecords']) ?? 0,
    droppedInterviews: num(value['droppedInterviews']) ?? 0,
    staleMirrors: num(value['staleMirrors']) ?? 0,
  };
}

/**
 * Rebuild a snapshot record by record.
 *
 * Nothing throws. A file that is JSON but holds the wrong shape yields whatever
 * of it was well formed, and the count of what was not is logged, so a
 * half-corrupt file costs the owner the corrupt half, not the whole history.
 */
export function validateOccasionState(
  raw: unknown,
): { snapshot: OccasionStateSnapshot; dropped: number } {
  if (!isRecord(raw)) return { snapshot: emptySnapshot(), dropped: 0 };
  let dropped = 0;
  const take = <T>(key: string, validate: (value: unknown) => T | null): T[] => {
    const list = Array.isArray(raw[key]) ? (raw[key] as readonly unknown[]) : [];
    const out: T[] = [];
    for (const entry of list) {
      const valid = validate(entry);
      if (valid === null) dropped += 1;
      else out.push(valid);
    }
    return out;
  };
  const openItems = take('openItems', validOpenItem);

  return {
    snapshot: {
      version: 1,
      acknowledgements: take('acknowledgements', validAcknowledgement),
      gifts: take('gifts', validGift),
      openItems,
      interviews: take('interviews', validInterview),
      mirrors: take('mirrors', validMirror),
      attributions: take('attributions', validAttribution),
      lastSweep: validSweepReport(raw['lastSweep']),
    },
    dropped,
  };
}

/** What a sweep needs to know from outside: which occasions still exist. */
export interface OccasionSweepInput {
  readonly today: IsoDate;
  readonly now: number;
  /**
   * Ids still declared in the profile. State for anything else is orphaned.
   * Absent means the caller cannot vouch for the declarations (the profile is
   * not loaded), so the orphan rules are skipped and only time-based expiry runs.
   */
  readonly declaredOccasionIds?: ReadonlySet<string> | undefined;
  /** How long gift history is kept, in years. */
  readonly giftHistoryYears: number;
}

export class OccasionStateStore {
  private readonly store: PersistentStore<OccasionStateSnapshot>;
  private snapshot: OccasionStateSnapshot | null = null;
  private loading: Promise<OccasionStateSnapshot> | undefined;
  /** Bumped on every published write; the integer a caller compares. */
  private publication = 0;

  /** Restricts a derived decision to the state it actually observed. */
  captureRead(): { readonly assertCurrent: () => void } {
    const publication = this.publication;
    return { assertCurrent: () => { if (this.publication !== publication) throw new Error('Occasion state changed.'); } };
  }
  private corruption: string | null = null;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();
  /** The group's record, once attached; it is used only while this machine is in a group. */
  private group: GroupWorkLink | null = null;
  /** Per occasion, the state this machine last wrote to or took from the group's record. */
  private readonly groupKnown = new Map<string, string>();
  /** Whether every occasion has been compared with the record once since this machine was in a group. */
  private groupTaken = false;

  constructor(private readonly filePath: string) {
    this.store = new PersistentStore<OccasionStateSnapshot>(filePath);
  }

  /**
   * Keep each occasion's state on the group's record (`occasion-state:<id>`,
   * state-replica.ts). In a group, an answer, a gift or a raised nudge
   * recorded on one machine is in every machine's state, so the machine that
   * holds the occasions role next does not ask again what was answered
   * elsewhere. Outside a group this changes nothing.
   */
  attachGroupWork(link: GroupWorkLink): () => void {
    this.group = link;
    return link.file.onChange((notice) => {
      if (notice.local) return;
      const ids = notice.keys.filter((key) => key.startsWith('occasion-state:')).map((key) => key.slice('occasion-state:'.length));
      if (ids.length > 0) void this.takeFromGroup(ids).catch((error: unknown) => {
        logger.warn('occasions: state from the group could not be taken in here', { error: String(error) });
      });
    });
  }

  /**
   * Take in occasions' state from the group's record. An occasion this machine
   * has not changed since it last wrote it takes the record's version whole
   * (a resolution or removal elsewhere stands); one changed here meanwhile is
   * merged record by record. With no `only`, every occasion, and state this
   * machine had before it joined goes onto the record.
   */
  async takeFromGroup(only?: readonly string[]): Promise<void> {
    const group = this.group;
    if (!groupWorkShared(group ?? undefined)) return;
    await this.state();
    const view = group!.file.view();
    if (!view) return;
    // The first comparison in a group covers every occasion, so state this
    // machine held before it joined goes onto the record.
    const full = only === undefined || !this.groupTaken;
    this.groupTaken = true;
    await this.change(snapshot => {
      const ids = !full && only ? only : [...new Set([...occasionIdsOf(snapshot), ...view.list('occasion-state').map((entry) => entry.id)])];
      let changed = false;
      for (const id of ids) {
        const entry = view.entry('occasion-state', id);
        if (!entry || entry.revoked) continue;
        const remote = sliceOf(validateOccasionState(entry.public.state).snapshot, id);
        const local = sliceOf(snapshot, id);
        const remoteJson = sliceJson(remote), localJson = sliceJson(local);
        if (remoteJson === localJson) { this.groupKnown.set(id, remoteJson); continue; }
        const unpublishedHere = this.groupKnown.has(id) ? this.groupKnown.get(id) !== localJson : !sliceIsEmpty(local);
        const next = unpublishedHere ? mergeOccasionSlices(local, remote) : remote;
        // Known as the record's version, so a merged result is written back by the publish that follows.
        this.groupKnown.set(id, remoteJson);
        if (sliceJson(next) === localJson) continue;
        Object.assign(snapshot, withSlice(snapshot, id, next));
        changed = true;
      }
      return changed;
    }, UNRESTRICTED_OPERATION, { publish: changed => changed });
    this.publishToGroup();
  }

  /**
   * Write every occasion whose state moved since this machine last wrote or
   * took it. An occasion another machine changed meanwhile is merged with it
   * under the record's lock, and the merged state is then taken in here too.
   */
  private publishToGroup(): void {
    const group = this.group;
    const snapshot = this.snapshot;
    if (!snapshot || !groupWorkShared(group ?? undefined)) return;
    if (!this.groupTaken) {
      void this.takeFromGroup().catch((error: unknown) => {
        logger.warn('occasions: state could not be compared with the group\'s record', { error: String(error) });
      });
      return;
    }
    const pending: Array<[string, OccasionSlice]> = [];
    for (const id of new Set([...occasionIdsOf(snapshot), ...this.groupKnown.keys()])) {
      const slice = sliceOf(snapshot, id);
      const json = sliceJson(slice);
      if (this.groupKnown.get(id) === json || (!this.groupKnown.has(id) && sliceIsEmpty(slice))) continue;
      pending.push([id, slice]);
    }
    if (pending.length === 0) return;
    const before = new Map(pending.map(([id]) => [id, this.groupKnown.get(id)]));
    const merged: Array<[string, OccasionSlice]> = [];
    void group!.file.write((view) => {
      const changes: AuthorityChange<null>[] = [];
      for (const [id, slice] of pending) {
        const entry = view.entry('occasion-state', id);
        let out = slice;
        if (entry && !entry.revoked) {
          const remote = sliceOf(validateOccasionState(entry.public.state).snapshot, id);
          const remoteJson = sliceJson(remote);
          // Changed elsewhere since this machine last saw it: keep both.
          if (remoteJson !== this.groupKnown.get(id) && remoteJson !== sliceJson(slice)) {
            out = mergeOccasionSlices(slice, remote);
            if (sliceJson(out) !== sliceJson(slice)) merged.push([id, out]);
          }
          if (sliceJson(out) === remoteJson) { this.groupKnown.set(id, remoteJson); continue; }
          changes.push({ kind: 'update', key: `occasion-state:${id}`, narrowsOrWidens: false, value: null, patch: { state: out } });
        } else if (!entry) {
          changes.push({ kind: 'issue', value: null, entries: [{ kind: 'occasion-state', id, public: { occasionId: id, state: out as unknown as Readonly<Record<string, unknown>> } }] });
        } else continue;
        this.groupKnown.set(id, sliceJson(out));
      }
      const decided: AuthorityChange<null> = changes.length > 0 ? { kind: 'many', changes, value: null } : { kind: 'none', value: null };
      return decided;
    }).then(async () => {
      if (merged.length === 0) return;
      await this.change(snapshot => {
        for (const [id, slice] of merged) Object.assign(snapshot, withSlice(snapshot, id, slice));
      });
    }).catch((error: unknown) => {
      for (const [id, known] of before) {
        if (known === undefined) this.groupKnown.delete(id);
        else this.groupKnown.set(id, known);
      }
      logger.warn('occasions: state could not be written to the group\'s record; the next change tries again', { error: String(error) });
    });
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Read the file once, discarding what it cannot understand.
   *
   * `loadOrDiscard` rather than `load`: this store's owner has a rule for a torn
   * record, drop it, record the fact, disclose it, and a store that only threw
   * would make every later call fail forever over one unreadable byte,
   * INCLUDING the disclosure call that exists to explain exactly that state.
   */
  async prepareRead(options: JudgmentReadingOptions = {}): Promise<void> {
    const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    assertCurrent(); await this.state(assertCurrent); assertCurrent();
  }

  private async state(assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<OccasionStateSnapshot> {
    assertCurrent();
    if (this.snapshot !== null && !this.loading) return this.snapshot;
    // The first load is shared by every caller that arrives while it runs, so it
    // is not fenced by any one caller: that caller giving up would otherwise fail
    // the others. Each caller applies its own fence after the wait.
    const loading = this.loading ?? (this.loading = this.loadState().finally(() => { this.loading = undefined; }));
    const snapshot = await loading;
    assertCurrent();
    return snapshot;
  }

  private async loadState(assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<OccasionStateSnapshot> {
    assertCurrent();
    const read = await this.store.loadOrDiscard();
    assertCurrent();
    if (read.corruption !== null) {
      this.corruption = read.corruption.detail;
      logger.warn('occasions: state file was unreadable and has been discarded', {
        path: this.filePath,
        detail: read.corruption.detail,
      });
      this.snapshot = emptySnapshot();
      return this.snapshot;
    }
    const { snapshot, dropped } = validateOccasionState(read.data);
    if (dropped > 0) {
      logger.warn('occasions: dropped malformed records while loading state', {
        path: this.filePath,
        dropped,
      });
    }
    this.snapshot = snapshot;
    return this.snapshot;
  }

  private async persist(snapshot: OccasionStateSnapshot, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<void> {
    await this.writes.run(() => {
      // Captured when this write's turn comes, so this store's own earlier write is not taken for a foreign one.
      const physical = this.filePath === ':memory:' || assertCurrent === UNRESTRICTED_OPERATION ? undefined : captureFileMutation(this.filePath);
      return this.store.persist({
        version: 1,
        acknowledgements: [...snapshot.acknowledgements],
        gifts: [...snapshot.gifts],
        openItems: [...snapshot.openItems],
        interviews: [...snapshot.interviews],
        mirrors: [...snapshot.mirrors],
        attributions: [...snapshot.attributions],
        lastSweep: snapshot.lastSweep,
      }, { assertCurrent, beforePublish: () => physical?.assertCurrent(),
        onEffect: published => { assertCurrent(); physical?.onEffect(published); } });
    });
  }

  /**
   * Serialize calculation as well as publication. No tentative state is visible
   * on refusal. Records are replaced, never mutated, so the copy is shallow per
   * collection; the loader validated every record field by field.
   */
  private async change<T>(mutate: (snapshot: OccasionStateSnapshot) => T, assertCurrent: () => void = UNRESTRICTED_OPERATION, options: { readonly publish?: (result: T) => boolean; readonly afterPublish?: () => void } = {}): Promise<T> {
    assertCurrent();
    await this.state(assertCurrent);
    let value!: T;
    await this.writes.run(async () => {
      // The file is observed when this write's turn comes, so a write queued
      // behind another of this store's own writes is not mistaken for a foreign
      // change by the one before it.
      // Only a foreign write to this store's own file stops the write; it is
      // compared once, just before the rename (one lstat).
      const physical = this.filePath === ':memory:' || assertCurrent === UNRESTRICTED_OPERATION ? undefined : captureFileMutation(this.filePath);
      assertCurrent();
      const receipts = occasionStateReceipts(assertCurrent);
      receipts?.onStateWriteIntent?.();
      const previous = this.snapshot!;
      const snapshot: OccasionStateSnapshot = {
        ...previous,
        acknowledgements: [...previous.acknowledgements],
        gifts: [...previous.gifts],
        openItems: [...previous.openItems],
        interviews: [...previous.interviews],
        mirrors: [...previous.mirrors],
        attributions: [...previous.attributions],
      };
      const result = mutate(snapshot);
      if (options.publish?.(result) === false) { value = result; return; }
      Object.freeze(snapshot);
      await this.store.persist(snapshot, { assertCurrent, withPublication: receipts?.withPublication,
        synchronousPublish: receipts?.withPublication !== undefined, onEffect: published => {
        receipts?.onStateEffect?.(published); physical?.onEffect(published);
      }, beforePublish: () => { assertCurrent(); physical?.assertCurrent(); }, afterPublish: () => {
        this.snapshot = snapshot; this.publication += 1; options.afterPublish?.();
        this.publishToGroup();
        // Answers, gifts, open items and interviews changed (also the daemon's own sweep): the dates views read them again.
        noteListChanged({ list: 'dates', change: 'changed' });
      } });
      value = result;
    });
    return value;
  }

  /** A yes and its prepared interview become visible together, or neither does. */
  async recordInterviewAnswer(entry: OccasionAcknowledgement, interview: Interview, resolvedId: string, assertCurrent: () => void, afterPublish: () => void = () => {}): Promise<void> {
    assertCurrent();
    const owned = entry;
    await this.change(snapshot => {
      snapshot.acknowledgements = [...snapshot.acknowledgements.filter(existing => !(existing.occasionId === owned.occasionId && existing.occurrence === owned.occurrence)), owned].slice(-MAX_ACKNOWLEDGEMENTS);
      snapshot.interviews = [...snapshot.interviews.filter(existing => existing.id !== interview.id), interview].slice(-MAX_INTERVIEWS);
      snapshot.openItems = snapshot.openItems.filter(item => item.id !== resolvedId);
    }, assertCurrent, { afterPublish });
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  /** The answer recorded for one occurrence, if there is one. */
  async answerFor(occasionId: string, occurrence: IsoDate): Promise<OccasionAcknowledgement | undefined> {
    const snapshot = await this.state();
    return snapshot.acknowledgements.find(
      (entry) => entry.occasionId === occasionId && entry.occurrence === occurrence,
    );
  }

  async acknowledgements(): Promise<readonly OccasionAcknowledgement[]> {
    return [...(await this.state()).acknowledgements];
  }

  /**
   * Record an answer, replacing any earlier answer for the SAME occurrence.
   *
   * Replacing rather than appending is the point: "later" then "no" is one
   * decision that changed, not two decisions, and keeping both would leave the
   * sweep reading whichever it found first.
   */
  async recordAnswer(entry: OccasionAcknowledgement, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<OccasionAcknowledgement> {
    assertCurrent();
    // A stored acknowledgement must be a real date: a free-form occurrence would
    // be read back as a malformed record and refuse every later pending read.
    if (entry.occurrence.trim() !== entry.occurrence || !isIsoDate(entry.occurrence)) {
      throw new RangeError('An occurrence must be an ISO date (YYYY-MM-DD).');
    }
    const owned = entry;
    return this.change(snapshot => {
      const kept = snapshot.acknowledgements.filter(
        (existing) => !(existing.occasionId === owned.occasionId && existing.occurrence === owned.occurrence),
      );
      kept.push(owned);
      if (kept.length > MAX_ACKNOWLEDGEMENTS) kept.splice(0, kept.length - MAX_ACKNOWLEDGEMENTS);
      snapshot.acknowledgements = kept;
      return entry;
    }, assertCurrent);
  }

  /**
   * Record "the owner has this occurrence in hand" as ONE write: the answer and
   * the open item it quiets change together, from the stored values, so there
   * is no state in which one landed and the other did not.
   *
   * A stored `yes` or `no` already settled the occurrence and says more than an
   * acknowledgement does, so it is left exactly as it is and nothing is written.
   */
  async acknowledge(
    entry: OccasionAcknowledgement,
    itemId: string,
    build: (existing: OpenItem | undefined) => OpenItem,
    assertCurrent: () => void = UNRESTRICTED_OPERATION,
  ): Promise<{ readonly settledBy: 'yes' | 'no' | null }> {
    assertCurrent();
    return this.change(snapshot => {
      const stored = snapshot.acknowledgements.find(
        (existing) => existing.occasionId === entry.occasionId && existing.occurrence === entry.occurrence,
      );
      if (stored?.answer === 'yes' || stored?.answer === 'no') return { settledBy: stored.answer };
      const kept = snapshot.acknowledgements.filter((existing) => existing !== stored);
      kept.push(entry);
      if (kept.length > MAX_ACKNOWLEDGEMENTS) kept.splice(0, kept.length - MAX_ACKNOWLEDGEMENTS);
      snapshot.acknowledgements = kept;
      const existing = snapshot.openItems.find((item) => item.id === itemId);
      const items = snapshot.openItems.filter((item) => item.id !== itemId);
      items.push(build(existing));
      if (items.length > MAX_OPEN_ITEMS) items.splice(0, items.length - MAX_OPEN_ITEMS);
      snapshot.openItems = items;
      return { settledBy: null };
    }, assertCurrent, { publish: (result) => result.settledBy === null });
  }

  // -------------------------------------------------------------------------
  // Attribution: who a date line is about, read once per line
  // -------------------------------------------------------------------------

  /** Every stored attribution, as last written. */
  async attributions(): Promise<readonly OccasionAttribution[]> {
    return [...(await this.state()).attributions];
  }

  /**
   * Store attributions read for lines that had none, or whose title, person or
   * the owner's declared names changed (the key says which). One write for the
   * whole batch, replacing any earlier reading for the same occasion.
   */
  async recordAttributions(entries: readonly OccasionAttribution[], assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<void> {
    if (entries.length === 0) return;
    await this.change(snapshot => {
      const replaced = new Set(entries.map((entry) => entry.occasionId));
      const kept = [...snapshot.attributions.filter((existing) => !replaced.has(existing.occasionId)), ...entries];
      if (kept.length > MAX_ATTRIBUTIONS) kept.splice(0, kept.length - MAX_ATTRIBUTIONS);
      snapshot.attributions = kept;
    }, assertCurrent);
  }

  // -------------------------------------------------------------------------
  // Gift history
  // -------------------------------------------------------------------------

  /** What the owner landed on for this occasion before, newest first. */
  async giftHistory(occasionId: string): Promise<readonly GiftRecord[]> {
    const snapshot = await this.state();
    return snapshot.gifts
      .filter((entry) => entry.occasionId === occasionId)
      .sort((left, right) => right.recordedAt - left.recordedAt);
  }

  async recordGift(entry: GiftRecord, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<GiftRecord> {
    assertCurrent();
    const owned = entry;
    return this.change(snapshot => {
      const kept = snapshot.gifts.filter(
        (existing) => !(existing.occasionId === owned.occasionId && existing.occurrence === owned.occurrence),
      );
      kept.push(owned);
      if (kept.length > MAX_GIFT_RECORDS) kept.splice(0, kept.length - MAX_GIFT_RECORDS);
      snapshot.gifts = kept;
      return entry;
    }, assertCurrent);
  }

  // -------------------------------------------------------------------------
  // Open items, the one mechanism behind "nothing unresolved is dropped"
  // -------------------------------------------------------------------------

  async openItems(): Promise<readonly OpenItem[]> {
    return [...(await this.state()).openItems];
  }

  async openItem(id: string): Promise<OpenItem | undefined> {
    return (await this.state()).openItems.find((entry) => entry.id === id);
  }

  /** Create or replace one open item, addressed by its id. */
  async putOpenItem(item: OpenItem, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<OpenItem> {
    assertCurrent();
    const owned = item;
    return this.change(snapshot => {
      const kept = snapshot.openItems.filter((existing) => existing.id !== owned.id);
      kept.push(owned);
      if (kept.length > MAX_OPEN_ITEMS) kept.splice(0, kept.length - MAX_OPEN_ITEMS);
      snapshot.openItems = kept;
      return item;
    }, assertCurrent);
  }

  /** Publish one derived sweep batch, renewing only its own committed state receipt. */
  async putOpenItems(items: readonly OpenItem[], assertCurrent: () => void, afterPublish: () => void): Promise<void> {
    assertCurrent();
    if (items.length === 0) return;
    await this.change(snapshot => {
      for (const item of items) {
        snapshot.openItems = [...snapshot.openItems.filter(existing => existing.id !== item.id), item].slice(-MAX_OPEN_ITEMS);
      }
    }, assertCurrent, { afterPublish });
  }

  /**
   * Create or change one open item inside a single write, so the item it builds
   * from is the one that is replaced and a concurrent change is not overwritten
   * by a stale copy. `build` receives the stored item, if any; returning null
   * leaves the store untouched.
   */
  async settleOpenItem(id: string, build: (existing: OpenItem | undefined) => OpenItem | null, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<OpenItem | null> {
    assertCurrent();
    return this.change(snapshot => {
      const item = build(snapshot.openItems.find((entry) => entry.id === id));
      if (item === null) return null;
      const kept = snapshot.openItems.filter((existing) => existing.id !== id);
      kept.push(item);
      if (kept.length > MAX_OPEN_ITEMS) kept.splice(0, kept.length - MAX_OPEN_ITEMS);
      snapshot.openItems = kept;
      return item;
    }, assertCurrent, { publish: value => value !== null });
  }

  /**
   * Remove an open item because it is RESOLVED.
   *
   * No tombstone and no resolved flag: a resolved item is gone, matching the
   * profile's own delete-means-delete rule. What survives resolution is the
   * thing that answers "what happened", the acknowledgement, or the gift
   * record, not a husk of the question.
   */
  async resolveOpenItem(id: string, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<boolean> {
    return this.change(snapshot => {
      const before = snapshot.openItems.length;
      snapshot.openItems = snapshot.openItems.filter((entry) => entry.id !== id);
      if (snapshot.openItems.length === before) return false;
      return true;
    }, assertCurrent, { publish: value => value });
  }

  // -------------------------------------------------------------------------
  // Interviews
  // -------------------------------------------------------------------------

  async interview(id: string): Promise<Interview | undefined> {
    return (await this.state()).interviews.find((entry) => entry.id === id);
  }

  /** The unfinished interview for one occurrence, if the owner walked away from one. */
  async activeInterview(occasionId: string, occurrence: IsoDate): Promise<Interview | undefined> {
    return (await this.state()).interviews.find(
      (entry) => entry.occasionId === occasionId
        && entry.occurrence === occurrence
        && entry.completedAt === undefined,
    );
  }

  /**
   * Change one stored interview inside a single write. Two answers that arrive
   * together each build from the interview the other left, so neither is lost.
   * Returns undefined, and writes nothing, when the interview is gone or `update`
   * declines it by returning null.
   */
  async updateInterview(id: string, update: (current: Interview) => Interview | null, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<Interview | undefined> {
    return this.change(snapshot => {
      const current = snapshot.interviews.find((entry) => entry.id === id);
      if (current === undefined) return undefined;
      const next = update(current);
      if (next === null) return undefined;
      snapshot.interviews = snapshot.interviews.map((entry) => (entry.id === id ? next : entry));
      return next;
    }, assertCurrent, { publish: value => value !== undefined });
  }

  async putInterview(interview: Interview, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<Interview> {
    return this.change(snapshot => {
      const kept = snapshot.interviews.filter((existing) => existing.id !== interview.id);
      kept.push(interview);
      if (kept.length > MAX_INTERVIEWS) kept.splice(0, kept.length - MAX_INTERVIEWS);
      snapshot.interviews = kept;
      return interview;
    }, assertCurrent);
  }

  // -------------------------------------------------------------------------
  // Calendar mirror
  // -------------------------------------------------------------------------

  /** Every occurrence written to the calendar, as `<occasionId>@<occurrence>` (occasionMirrorKey): one read of the state. */
  async mirroredOccurrences(): Promise<ReadonlySet<string>> {
    return new Set((await this.state()).mirrors.map((entry) => occasionMirrorKey(entry.occasionId, entry.occurrence)));
  }

  /** The mirror already written for this occurrence, if there is one. */
  async mirrorFor(occasionId: string, occurrence: IsoDate): Promise<OccasionMirrorRecord | undefined> {
    return (await this.state()).mirrors.find(
      (entry) => entry.occasionId === occasionId && entry.occurrence === occurrence,
    );
  }

  /**
   * Remember that one occurrence has been written out.
   *
   * Keyed by occasion AND occurrence, replacing rather than appending, which is
   * what makes the mirror idempotent: writing the same occasion again next year
   * adds one record, and writing it twice this year replaces one.
   */
  async recordMirror(entry: OccasionMirrorRecord, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<OccasionMirrorRecord> {
    return this.change(snapshot => {
      const kept = snapshot.mirrors.filter(
        (existing) => !(existing.occasionId === entry.occasionId && existing.occurrence === entry.occurrence),
      );
      kept.push(entry);
      if (kept.length > MAX_MIRRORS) kept.splice(0, kept.length - MAX_MIRRORS);
      snapshot.mirrors = kept;
      return entry;
    }, assertCurrent);
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  /**
   * Drop every record belonging to one occasion.
   *
   * Called when the owner removes an occasion. People divorce and people die;
   * removing an occasion takes one sentence and one confirm, and it must not
   * leave last year's "no" and a gift history for a person who is no longer in
   * their life sitting in a file they cannot see.
   */
  async dropOccasion(occasionId: string, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<number> {
    return this.change(snapshot => {
      const before = snapshot.acknowledgements.length + snapshot.gifts.length
        + snapshot.openItems.length + snapshot.interviews.length + snapshot.mirrors.length;
      snapshot.acknowledgements = snapshot.acknowledgements.filter((e) => e.occasionId !== occasionId);
      snapshot.gifts = snapshot.gifts.filter((e) => e.occasionId !== occasionId);
      snapshot.openItems = snapshot.openItems.filter((e) => e.occasionId !== occasionId);
      snapshot.interviews = snapshot.interviews.filter((e) => e.occasionId !== occasionId);
      snapshot.mirrors = snapshot.mirrors.filter((e) => e.occasionId !== occasionId);
      // A reading about a removed line is bookkeeping, not a record the owner
      // would count, so it goes without adding to the number reported back.
      snapshot.attributions = snapshot.attributions.filter((e) => e.occasionId !== occasionId);
      const after = snapshot.acknowledgements.length + snapshot.gifts.length
        + snapshot.openItems.length + snapshot.interviews.length + snapshot.mirrors.length;
      return before - after;
    }, assertCurrent, { publish: value => value > 0 });
  }

  /**
   * The periodic reap.
   *
   * Four rules, each with an owner-visible consequence:
   *
   *  - An answer whose occurrence has passed is dropped, so next year asks
   *    fresh and carries no memory of the refusal. A one-off answer has no
   *    expiry and stays: "handled" is permanent for something that happens once.
   *  - State for an occasion no longer declared is orphaned and dropped. This is
   *    the safety net behind the explicit removal path, for the case where the
   *    owner deleted the line in their editor rather than through a verb. A
   *    line that is still there but does not parse is still declared (the
   *    caller passes the id of every titled line), so a typo costs nothing.
   *    Gift history is the exception: it is never reaped as an orphan, because
   *    a retitled line would otherwise lose years of it. It leaves by age or by
   *    an explicit removal, and stays readable under its old id until then.
   *  - An open item whose occurrence has passed stops being raised. Nothing
   *    unresolved is ever dropped WHILE IT CAN STILL MATTER; a birthday that
   *    was three weeks ago cannot.
   *  - Gift history ages out at the configured retention rather than never,
   *    because a persisted store with no reaper is unbounded by design.
   */
  async sweep(input: OccasionSweepInput, assertCurrent: () => void = UNRESTRICTED_OPERATION): Promise<OccasionSweepReport> {
    return this.change(snapshot => {
      const declaredIds = input.declaredOccasionIds;
      const isOrphan = (occasionId: string): boolean => declaredIds !== undefined && !declaredIds.has(occasionId);
      const giftCutoff = addDays(input.today, -Math.max(1, Math.round(input.giftHistoryYears * 365)));

      let expiredAcknowledgements = 0;
      let orphanedRecords = 0;
      let expiredOpenItems = 0;
      let agedGiftRecords = 0;
      let droppedInterviews = 0;
      let staleMirrors = 0;

      snapshot.acknowledgements = snapshot.acknowledgements.filter((entry) => {
        if (isOrphan(entry.occasionId)) { orphanedRecords += 1; return false; }
        if (entry.expiresAfter !== undefined && entry.expiresAfter < input.today) {
          expiredAcknowledgements += 1;
          return false;
        }
        return true;
      });

      snapshot.gifts = snapshot.gifts.filter((entry) => {
        if (entry.occurrence < giftCutoff) { agedGiftRecords += 1; return false; }
        return true;
      });

      snapshot.attributions = snapshot.attributions.filter((entry) => !isOrphan(entry.occasionId));

      snapshot.openItems = snapshot.openItems.filter((entry) => {
        if (isOrphan(entry.occasionId)) { orphanedRecords += 1; return false; }
        const expiry = entry.expiresAfter ?? (entry.occurrence.length > 0 ? entry.occurrence : undefined);
        if (expiry !== undefined && expiry < input.today) { expiredOpenItems += 1; return false; }
        return true;
      });

      snapshot.interviews = snapshot.interviews.filter((entry) => {
        if (isOrphan(entry.occasionId)) { droppedInterviews += 1; return false; }
        if (entry.occurrence < input.today && entry.completedAt === undefined) {
          droppedInterviews += 1;
          return false;
        }
        return true;
      });

      snapshot.mirrors = snapshot.mirrors.filter((entry) => {
        if (isOrphan(entry.occasionId)) { staleMirrors += 1; return false; }
        // A mirror for an occurrence that has passed has nothing left to keep
        // idempotent. Dropping it is not a deletion in the calendar: the mirror
        // is not the record, and the calendar entry is the calendar's to keep.
        if (entry.occurrence < input.today) { staleMirrors += 1; return false; }
        return true;
      });

      const report: OccasionSweepReport = {
        sweptAt: input.now,
        expiredAcknowledgements,
        orphanedRecords,
        expiredOpenItems,
        agedGiftRecords,
        droppedInterviews,
        staleMirrors,
      };
      snapshot.lastSweep = report;
      return report;
    }, assertCurrent);
  }

  /** What this store is holding, and what the last sweep removed. */
  async disclose(): Promise<OccasionStateDisclosure> {
    const snapshot = await this.state();
    return {
      path: this.filePath,
      acknowledgements: snapshot.acknowledgements.length,
      giftRecords: snapshot.gifts.length,
      openItems: snapshot.openItems.length,
      interviews: snapshot.interviews.length,
      mirrors: snapshot.mirrors.length,
      attributions: snapshot.attributions.length,
      lastSweep: snapshot.lastSweep,
      corruption: this.corruption,
    };
  }

  /** Settles when every queued write has finished. Test and shutdown seam. */
  async drain(): Promise<void> {
    await this.writes.drain();
  }
}


/**
 * state-replica.ts, one occasion's answered state as the group's record
 * carries it (`occasion-state:<occasionId>`), so an occasion answered on one
 * machine of a group is not asked again by another.
 *
 * The unit is the occasion: every answer, gift, open item, interview, mirror
 * and attribution of one occasion travels together, because "do not ask
 * again" is read from more than one of them (the answer, and the boundaries an
 * open item has already been raised at). Pure: the store (state-store.ts) does
 * the reading and writing.
 *
 * Two machines that change one occasion at the same moment are merged record
 * by record, the later stamp winning and nothing either of them added lost
 * (`mergeOccasionSlices`). Without a concurrent change, the later write simply
 * replaces the occasion's state, so a resolution or a removal stands.
 */
import type {
  GiftRecord,
  Interview,
  OccasionAcknowledgement,
  OccasionAttribution,
  OccasionMirrorRecord,
  OpenItem,
} from './types.js';
import { canonicalJson } from '../cluster/group-work.js';

/** The collections of the state file that belong to one occasion. */
export interface OccasionSlice {
  readonly acknowledgements: readonly OccasionAcknowledgement[];
  readonly gifts: readonly GiftRecord[];
  readonly openItems: readonly OpenItem[];
  readonly interviews: readonly Interview[];
  readonly mirrors: readonly OccasionMirrorRecord[];
  readonly attributions: readonly OccasionAttribution[];
}

type SliceKey = keyof OccasionSlice;

const SLICE_KEYS: readonly SliceKey[] = ['acknowledgements', 'gifts', 'openItems', 'interviews', 'mirrors', 'attributions'];

/** How each collection is keyed within one occasion, and which copy of a key is the later one. */
const IDENTITY: { readonly [K in SliceKey]: { readonly key: (value: OccasionSlice[K][number]) => string; readonly stamp: (value: OccasionSlice[K][number]) => number } } = {
  acknowledgements: { key: (value) => value.occurrence, stamp: (value) => value.answeredAt },
  gifts: { key: (value) => value.occurrence, stamp: (value) => value.recordedAt },
  openItems: { key: (value) => value.id, stamp: (value) => Math.max(value.lastRaisedAt, value.openedAt) },
  interviews: {
    key: (value) => value.id,
    stamp: (value) => Math.max(value.startedAt, value.completedAt ?? 0, ...value.answers.map((answer) => answer.answeredAt)),
  },
  mirrors: { key: (value) => value.occurrence, stamp: (value) => value.mirroredAt },
  attributions: { key: (value) => value.key, stamp: (value) => value.readAt },
};

function sortedBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Every occasion id the snapshot holds state for. */
export function occasionIdsOf(snapshot: OccasionSlice): Set<string> {
  const ids = new Set<string>();
  for (const name of SLICE_KEYS) for (const value of snapshot[name]) ids.add(value.occasionId);
  return ids;
}

/** One occasion's state, each collection in key order so two copies compare equal. */
export function sliceOf(snapshot: OccasionSlice, occasionId: string): OccasionSlice {
  const pick = <K extends SliceKey>(name: K): OccasionSlice[K] =>
    sortedBy((snapshot[name] as readonly OccasionSlice[K][number][]).filter((value) => value.occasionId === occasionId),
      IDENTITY[name].key as (value: OccasionSlice[K][number]) => string) as unknown as OccasionSlice[K];
  return {
    acknowledgements: pick('acknowledgements'),
    gifts: pick('gifts'),
    openItems: pick('openItems'),
    interviews: pick('interviews'),
    mirrors: pick('mirrors'),
    attributions: pick('attributions'),
  };
}

export function sliceJson(slice: OccasionSlice): string {
  return canonicalJson(slice);
}

export function sliceIsEmpty(slice: OccasionSlice): boolean {
  return SLICE_KEYS.every((name) => slice[name].length === 0);
}

/** `snapshot` with one occasion's state replaced by `slice`. Other occasions are untouched. */
export function withSlice<S extends OccasionSlice>(snapshot: S, occasionId: string, slice: OccasionSlice): S {
  const keep = <K extends SliceKey>(name: K): OccasionSlice[K] =>
    [...(snapshot[name] as readonly OccasionSlice[K][number][]).filter((value) => value.occasionId !== occasionId),
      ...(slice[name] as readonly OccasionSlice[K][number][]).filter((value) => value.occasionId === occasionId)] as unknown as OccasionSlice[K];
  const replaced: OccasionSlice = {
    ...snapshot,
    acknowledgements: keep('acknowledgements'),
    gifts: keep('gifts'),
    openItems: keep('openItems'),
    interviews: keep('interviews'),
    mirrors: keep('mirrors'),
    attributions: keep('attributions'),
  };
  // The arrays are fresh copies, so the caller may own them as its snapshot's.
  return replaced as unknown as S;
}

/**
 * Two concurrent versions of one occasion's state, merged: per record, the
 * later stamp wins (equal stamps settle on the larger canonical form, so
 * every machine picks the same one), and a record only one side has is kept.
 * An open item keeps every boundary either side has raised it at, so the
 * merge can only make a nudge quieter, never ask again.
 */
export function mergeOccasionSlices(a: OccasionSlice, b: OccasionSlice): OccasionSlice {
  const merge = <K extends SliceKey>(name: K): OccasionSlice[K] => {
    const { key, stamp } = IDENTITY[name] as { key: (value: OccasionSlice[K][number]) => string; stamp: (value: OccasionSlice[K][number]) => number };
    const byKey = new Map<string, OccasionSlice[K][number]>();
    for (const value of [...(a[name] as readonly OccasionSlice[K][number][]), ...(b[name] as readonly OccasionSlice[K][number][])]) {
      const id = key(value);
      const held = byKey.get(id);
      if (!held) { byKey.set(id, value); continue; }
      const later = stamp(value) !== stamp(held)
        ? (stamp(value) > stamp(held) ? value : held)
        : (canonicalJson(value) > canonicalJson(held) ? value : held);
      byKey.set(id, later);
    }
    return sortedBy([...byKey.values()], key) as unknown as OccasionSlice[K];
  };
  const openItems = (merge('openItems') as readonly OpenItem[]).map((item) => {
    const served = new Set(item.servedBoundaries);
    for (const side of [a.openItems, b.openItems]) for (const other of side) if (other.id === item.id) for (const boundary of other.servedBoundaries) served.add(boundary);
    return served.size === item.servedBoundaries.length ? item : { ...item, servedBoundaries: [...served].sort() };
  });
  return {
    acknowledgements: merge('acknowledgements'),
    gifts: merge('gifts'),
    openItems,
    interviews: merge('interviews'),
    mirrors: merge('mirrors'),
    attributions: merge('attributions'),
  };
}

/**
 * usePlaceLists, the open place's lists and every place's count, read by
 * themselves and kept current.
 *
 * Every place's count comes from the daemon in one call (`places.counts`: each
 * place's own count over its own lists), read when the places open; a place's
 * lists are read when that place is opened (lists of one method and input are
 * one call). One subscription on the app's event lane (lib/event-stream.ts,
 * whose domains carry everything the places follow, so it never reopens)
 * carries the union of what every place's lists follow: a frame reads again
 * the open place's lists it touches, and the counts when it touches any list.
 * No poll and no timer: a list that could not be read is read again when the
 * lane is live again (the daemon answering), and after a lane that dropped
 * comes back the open place and the counts are read again, since frames may
 * have been missed meanwhile. A read or count made while another is in flight
 * is made once more after it, never dropped.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeEvents } from '../lib/event-stream';
import { formatError, isDaemonUnreachableError } from '../lib/errors';
import {
  WEB_PLACES, frameNamesOf, frameTouches, interestOf, readKey, readPlaceCounts, readSource, webListsOf,
  type AnyPlace, type PlaceCountRow, type PlaceItem, type PlaceList,
} from '../lib/places';

export interface PlaceListState {
  readonly status: 'reading' | 'ready' | 'failed';
  readonly items: readonly PlaceItem[];
  /** Why it could not be read, in the daemon's or the browser's words. */
  readonly reason?: string | undefined;
  /** It could not be read because the daemon did not answer (it is read again when it does). */
  readonly unreachable?: boolean | undefined;
  /** A read finished at least once (a failed read after one keeps the items it had). */
  readonly read: boolean;
}

const READING: PlaceListState = { status: 'reading', items: [], read: false };

interface Entry {
  readonly place: AnyPlace;
  readonly list: PlaceList<PlaceItem>;
  readonly slot: string;
}

/** A list's slot in the state: `<place>/<list>`. */
export function slotOf(place: AnyPlace, list: PlaceList<PlaceItem>): string {
  return `${place.id}/${list.id}`;
}

const ENTRIES: readonly Entry[] = WEB_PLACES.flatMap((place) => webListsOf(place).shown.map((list) => ({ place, list, slot: slotOf(place, list) })));

export interface PlaceLists {
  /** A list's state now. */
  stateOf(place: AnyPlace, list: PlaceList<PlaceItem>): PlaceListState;
  /** Every place's count as the daemon made it (by place id); empty until read. */
  readonly counts: Readonly<Record<string, PlaceCountRow>>;
  /** Why the counts could not be read, when they could not. */
  readonly countsFailed: string | undefined;
  /** Read a place's lists and every count now (Read again, and after an action ran). */
  readPlace(place: AnyPlace): void;
}

/** Whether a LIST_CHANGED frame (the envelope or its payload) names a project other than the chosen one. */
function aboutAnotherProject(frame: unknown, chosen: string | undefined | null): boolean {
  if (!chosen) return false;
  const outer = (typeof frame === 'object' && frame !== null ? frame : {}) as { project?: unknown; payload?: unknown };
  const inner = (typeof outer.payload === 'object' && outer.payload !== null ? outer.payload : {}) as { project?: unknown };
  const project = typeof inner.project === 'string' ? inner.project : typeof outer.project === 'string' ? outer.project : undefined;
  const bare = (path: string): string => path.replace(/\/+$/, '');
  return project !== undefined && bare(project) !== bare(chosen);
}

/** Strip the transport's "(HTTP 400 · bad_request)" from the daemon's own words. */
const ownWords = (error: unknown): string => formatError(error).replace(/\s*\(HTTP \d+[^)]*\)\.?\s*$/, '');

/** `project`: the chosen project; `null` while the projects are still being read (nothing is read until then). */
export function usePlaceLists(open: AnyPlace | undefined, project: string | undefined | null): PlaceLists {
  const [states, setStates] = useState<Readonly<Record<string, PlaceListState>>>({});
  const statesRef = useRef(states);
  useEffect(() => { statesRef.current = states; }, [states]);
  const [counts, setCounts] = useState<Readonly<Record<string, PlaceCountRow>>>({});
  const [countsFailed, setCountsFailed] = useState<string | undefined>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  const byKey = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const entry of ENTRIES) {
      const key = `${entry.place.id} ${readKey(entry.list)}`;
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
    return map;
  }, []);

  /** Per key: a read in flight, and whether another was asked for meanwhile (made once more after it). */
  const inFlight = useRef(new Map<string, { again: boolean }>());

  /** Read these keys, one call each, and give every list of a key its own items from the one answer. */
  const readKeys = useCallback(async (keys: Iterable<string>): Promise<void> => {
    await Promise.allSettled([...new Set(keys)].map(async function readKey(key: string): Promise<void> {
      const entries = byKey.get(key);
      if (!entries || entries.length === 0) return;
      const running = inFlight.current.get(key);
      if (running) { running.again = true; return; }
      const mine = { again: false };
      inFlight.current.set(key, mine);
      setStates((now) => {
        const next = { ...now };
        for (const { slot } of entries) {
          const held = now[slot];
          if (held?.status === 'failed') next[slot] = { ...held, status: 'reading' };
          else if (!held) next[slot] = READING;
        }
        return next;
      });
      let output: unknown;
      let failure: string | undefined;
      let unreachable = false;
      // The project this read is for: an answer for a project the person has since switched away from is not shown.
      const askedFor = projectRef.current;
      try {
        output = await readSource(entries[0]!.list, askedFor ?? undefined);
      } catch (error) {
        failure = ownWords(error);
        unreachable = isDaemonUnreachableError(error);
      }
      inFlight.current.delete(key);
      if (!mounted.current) return;
      if (projectRef.current !== askedFor) { await readKey(key); return; }
      setStates((now) => {
        const next = { ...now };
        for (const { list, slot } of entries) {
          const held = now[slot] ?? READING;
          if (failure !== undefined) { next[slot] = { status: 'failed', items: held.items, reason: failure, unreachable, read: held.read }; continue; }
          try {
            next[slot] = { status: 'ready', items: list.source.kind === 'daemon' ? list.source.items(output) : [], read: true };
          } catch (error) {
            next[slot] = { status: 'failed', items: held.items, reason: formatError(error), read: held.read };
          }
        }
        return next;
      });
      if (mine.again) await readKey(key);
    }));
  }, [byKey]);

  const counting = useRef<{ again: boolean } | null>(null);
  /** Every place's count, in one call; asked again while one is in flight, it is made once more after it. */
  const readCounts = useCallback(async (): Promise<void> => {
    if (counting.current) { counting.current.again = true; return; }
    const mine = { again: false };
    counting.current = mine;
    try {
      const askedFor = projectRef.current;
      const read = await readPlaceCounts(askedFor ?? undefined);
      // Counts made for a project the person has since switched away from are not shown: they are made again.
      if (projectRef.current !== askedFor) mine.again = true;
      else if (mounted.current) { setCounts(read); setCountsFailed(undefined); }
    } catch (error) {
      if (mounted.current) setCountsFailed(ownWords(error));
    } finally {
      counting.current = null;
      if (mine.again && mounted.current) void readCounts();
    }
  }, []);

  const keysOfPlace = useCallback((place: AnyPlace): string[] => webListsOf(place).shown.map((list) => `${place.id} ${readKey(list)}`), []);

  // The counts when the places open, and again for another project.
  useEffect(() => { if (project !== null) void readCounts(); }, [readCounts, project]);
  // A place's lists when it is opened, and again for another project.
  useEffect(() => { if (open && project !== null) void readKeys(keysOfPlace(open)); }, [open, project, keysOfPlace, readKeys]);

  // One subscription for every place: a frame reads again the open place's lists it touches, and the counts.
  useEffect(() => {
    const interests = ENTRIES.map((entry) => ({ entry, key: `${entry.place.id} ${readKey(entry.list)}`, interest: interestOf(entry.list, entry.place) }));
    const domains = [...new Set(interests.flatMap(({ interest }) => interest.domains))];
    const frames = [...new Set(interests.flatMap(({ interest }) => [...interest.frames, ...(interest.lists.length > 0 ? ['workspace'] : [])]))];
    if (domains.length === 0) return undefined;
    const openKeys = (): string[] => (openRef.current ? keysOfPlace(openRef.current) : []);
    return subscribeEvents({
      domains,
      events: frames,
      onEvent: (name, payload) => {
        // A change notice about another project's list is nothing the chosen project shows.
        if (aboutAnotherProject(payload, projectRef.current)) return;
        const named = frameNamesOf(payload);
        const touched = interests.filter(({ interest }) => frameTouches(interest, name, named));
        if (touched.length === 0) return;
        void readCounts();
        const mine = new Set(openKeys());
        const reread = touched.map(({ key }) => key).filter((key) => mine.has(key));
        if (reread.length > 0) void readKeys(reread);
      },
      // Live again: after a drop the open place and the counts are read (frames may have been missed); a lane that
      // never opened before (the daemon was down when the places opened) reads what could not be read.
      onReady: (resumed) => {
        if (resumed) { void readKeys(openKeys()); void readCounts(); return; }
        const failed = openKeys().filter((key) => (byKey.get(key) ?? []).some(({ slot }) => statesRef.current[slot]?.status === 'failed'));
        if (failed.length > 0) void readKeys(failed);
        void readCounts();
      },
      onGap: () => { void readKeys(openKeys()); void readCounts(); },
    });
  }, [byKey, keysOfPlace, readCounts, readKeys]);

  const stateOf = useCallback((place: AnyPlace, list: PlaceList<PlaceItem>) => states[slotOf(place, list)] ?? READING, [states]);
  const readPlace = useCallback((place: AnyPlace) => { void readKeys(keysOfPlace(place)); void readCounts(); }, [keysOfPlace, readCounts, readKeys]);
  return { stateOf, counts, countsFailed, readPlace };
}

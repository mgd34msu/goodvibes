/**
 * usePlaceLists, every web place's lists, read by themselves and kept current.
 *
 * While the places are open, each list of each place the browser draws is
 * read from its daemon source (the open place first, so it shows at once;
 * lists of one method and input are one call), which is also what the
 * navigation's counts are made from, as the terminal's menu does. One
 * subscription on the app's event lane (lib/event-stream.ts) carries the union
 * of what the lists follow: a frame reads again only the lists it touches. No
 * poll and no timer: a list that could not be read is read again when the lane
 * is live again (the daemon answering), and after a lane that dropped comes
 * back every list is read again, since frames may have been missed meanwhile.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeEvents } from '../lib/event-stream';
import { formatError } from '../lib/errors';
import {
  WEB_PLACES, changedListOf, frameTouches, interestOf, readKey, readSource, webListsOf, type AnyPlace, type PlaceItem, type PlaceList,
} from '../lib/places';

export interface PlaceListState {
  readonly status: 'reading' | 'ready' | 'failed';
  readonly items: readonly PlaceItem[];
  /** Why it could not be read, in the daemon's or the browser's words. */
  readonly reason?: string | undefined;
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
  /** A place's lists as read, by list id (what its `count` reads). */
  itemsOf(place: AnyPlace): Readonly<Record<string, readonly PlaceItem[]>>;
  /** Read a place's lists now (Read again, and after an action ran). */
  readPlace(place: AnyPlace): void;
}

export function usePlaceLists(first: AnyPlace | undefined): PlaceLists {
  const [states, setStates] = useState<Readonly<Record<string, PlaceListState>>>({});
  const statesRef = useRef(states);
  useEffect(() => { statesRef.current = states; }, [states]);
  /** The newest read of each key wins. */
  const seq = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const byKey = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const entry of ENTRIES) {
      const key = readKey(entry.list);
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
    return map;
  }, []);

  /** Read these keys, one call each, and give every list of a key its own items from the one answer. */
  const readKeys = useCallback(async (keys: Iterable<string>): Promise<void> => {
    await Promise.allSettled([...new Set(keys)].map(async (key) => {
      const entries = byKey.get(key);
      if (!entries || entries.length === 0) return;
      const mine = (seq.current.get(key) ?? 0) + 1;
      seq.current.set(key, mine);
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
      try {
        output = await readSource(entries[0]!.list);
      } catch (error) {
        failure = formatError(error);
      }
      if (!mounted.current || seq.current.get(key) !== mine) return;
      setStates((now) => {
        const next = { ...now };
        for (const { list, slot } of entries) {
          const held = now[slot] ?? READING;
          if (failure !== undefined) { next[slot] = { status: 'failed', items: held.items, reason: failure, read: held.read }; continue; }
          try {
            next[slot] = { status: 'ready', items: list.source.kind === 'daemon' ? list.source.items(output) : [], read: true };
          } catch (error) {
            next[slot] = { status: 'failed', items: held.items, reason: formatError(error), read: held.read };
          }
        }
        return next;
      });
    }));
  }, [byKey]);

  const keysOfPlace = useCallback((place: AnyPlace): string[] => webListsOf(place).shown.map(readKey), []);

  // On open: the place in front first, then every other place's lists (the navigation's counts).
  const firstId = useRef(first?.id);
  useEffect(() => {
    const front = WEB_PLACES.find((place) => place.id === firstId.current);
    const frontKeys = front ? keysOfPlace(front) : [];
    void readKeys(frontKeys).then(() => {
      if (!mounted.current) return;
      void readKeys([...byKey.keys()].filter((key) => !frontKeys.includes(key)));
    });
  }, [byKey, keysOfPlace, readKeys]);

  // One subscription for every list: a frame reads again the lists it touches.
  useEffect(() => {
    const interests = ENTRIES.map((entry) => ({ key: readKey(entry.list), interest: interestOf(entry.list) }));
    const domains = [...new Set(interests.flatMap(({ interest }) => interest.domains))];
    const frames = [...new Set(interests.flatMap(({ interest }) => [...interest.frames, ...(interest.lists.length > 0 ? ['workspace'] : [])]))];
    if (domains.length === 0) return undefined;
    return subscribeEvents({
      domains,
      events: frames,
      onEvent: (name, payload) => {
        const changed = name === 'workspace' ? changedListOf(payload) : undefined;
        const touched = interests.filter(({ interest }) => frameTouches(interest, name, changed)).map(({ key }) => key);
        if (touched.length > 0) void readKeys(touched);
      },
      // Live again: after a drop every list is read (frames may have been missed); a lane that never opened before
      // (the daemon was down when the places opened) reads the lists that could not be read.
      onReady: (resumed) => {
        if (resumed) { void readKeys(byKey.keys()); return; }
        const failed = ENTRIES.filter(({ slot }) => statesRef.current[slot]?.status === 'failed').map(({ list }) => readKey(list));
        if (failed.length > 0) void readKeys(failed);
      },
      onGap: () => { void readKeys(byKey.keys()); },
    });
  }, [byKey, readKeys]);

  const stateOf = useCallback((place: AnyPlace, list: PlaceList<PlaceItem>) => states[slotOf(place, list)] ?? READING, [states]);
  const itemsOf = useCallback((place: AnyPlace) => Object.fromEntries(
    webListsOf(place).shown.map((list) => [list.id, states[slotOf(place, list)]?.items ?? []]),
  ), [states]);
  const readPlace = useCallback((place: AnyPlace) => { void readKeys(keysOfPlace(place)); }, [keysOfPlace, readKeys]);
  return { stateOf, itemsOf, readPlace };
}

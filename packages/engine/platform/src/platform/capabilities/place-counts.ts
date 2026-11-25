/**
 * place-counts.ts, every place's count in one call (`places.counts`,
 * method-catalog-capabilities.ts): what waits or is wrong in each place, for a
 * menu of places as it opens (the web view's rail, the terminal programs'
 * menu).
 *
 * The daemon is given the places as they are declared (terminal-shell
 * places/browser.ts, by the daemon's host): a count is each place's own
 * `count`, made from its own lists read from their own daemon sources, so a
 * count and the lists it summarises cannot disagree. A list the daemon cannot
 * read (one a terminal program keeps, a `session` or `program` source) counts
 * as empty here; a program that keeps it counts that place itself. Lists of one
 * method and input are one call. A list whose read is refused counts nothing and
 * is named in `unread`, so a caller can tell an empty place from one it could
 * not see.
 */

/** An item as a count reads it: its id and state (terminal-shell place-types.ts `PlaceItem`). */
export interface CountedItem {
  readonly id: string;
  readonly state: string;
}

/** A place's count: what waits or is wrong (terminal-shell place-types.ts `PlaceCount`). */
export interface CountedPlaceCount {
  readonly count: number;
  readonly words: string;
  readonly tone: 'waiting' | 'wrong';
}

/** The part of a place declaration a count reads (terminal-shell place-types.ts `PlaceDeclaration`). */
export interface CountedPlace {
  readonly id: string;
  readonly lists: readonly {
    readonly id: string;
    readonly source: {
      readonly kind: string;
      readonly method?: string | undefined;
      readonly input?: Readonly<Record<string, unknown>> | undefined;
      /** The input the caller's project is sent as, for a list bound to a project. */
      readonly projectAs?: string | undefined;
      readonly items: (output: unknown) => readonly CountedItem[];
    };
    readonly programs?: readonly string[] | undefined;
  }[];
  readonly count?: ((lists: Readonly<Record<string, readonly CountedItem[]>>) => CountedPlaceCount | undefined) | undefined;
  /** The lists `count` reads (terminal-shell place-types.ts `countFrom`): only these are read for the count. Absent: every list. */
  readonly countFrom?: readonly string[] | undefined;
}

export interface PlaceCountRow {
  readonly place: string;
  /** Absent when nothing waits or is wrong. */
  readonly count?: number | undefined;
  readonly words?: string | undefined;
  readonly tone?: 'waiting' | 'wrong' | undefined;
  /** The lists whose read was refused (their ids): the count is made without them. */
  readonly unread?: readonly string[] | undefined;
}

export interface PlaceCountRequest {
  /** The program whose view is counted (`tui`, `agent`, `web`): a list declared for other programs only is not read. */
  readonly program?: string | undefined;
  /** The caller's project, sent with every read through `capabilities.run` (a project-bound list). */
  readonly workingDirectory?: string | undefined;
}

/** Read one daemon method as the caller; throws its refusal. */
export type PlaceCountRead = (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** Every place's count, each list read once (lists of one method and input share the call). */
export async function countPlaces(places: readonly CountedPlace[], request: PlaceCountRequest, read: PlaceCountRead): Promise<readonly PlaceCountRow[]> {
  const calls = new Map<string, Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false }>>();
  const call = (method: string, input: Readonly<Record<string, unknown>>, projectAs: string | undefined) => {
    // A read bound to a project carries the caller's, as the place's own read does (capabilities.run as workingDirectory).
    const field = method === 'capabilities.run' ? 'workingDirectory' : projectAs;
    const sent = field && request.workingDirectory ? { ...input, [field]: request.workingDirectory } : input;
    const key = `${method} ${JSON.stringify(sent)}`;
    let held = calls.get(key);
    if (!held) {
      held = read(method, sent).then((output) => ({ ok: true as const, output }), () => ({ ok: false as const }));
      calls.set(key, held);
    }
    return held;
  };
  return Promise.all(places.filter((place) => place.count !== undefined).map(async (place): Promise<PlaceCountRow> => {
    const lists: Record<string, readonly CountedItem[]> = {};
    const unread: string[] = [];
    await Promise.all(place.lists.map(async (list) => {
      lists[list.id] ??= [];
      if (list.source.kind !== 'daemon' || !list.source.method) return;
      // A list the count does not read is not read for it (a calendar's events, a Google connection's steps).
      if (place.countFrom && !place.countFrom.includes(list.id)) return;
      if (request.program && list.programs && !list.programs.includes(request.program)) return;
      // A list bound to a project is not read for a caller who named none: the daemon's own folder is never assumed.
      if (list.source.projectAs && !request.workingDirectory) return;
      const answer = await call(list.source.method, list.source.input ?? {}, list.source.projectAs);
      if (!answer.ok) { unread.push(list.id); return; }
      try { lists[list.id] = list.source.items(answer.output); } catch { unread.push(list.id); }
    }));
    let counted: CountedPlaceCount | undefined;
    try { counted = place.count?.(lists); } catch { counted = undefined; }
    return {
      place: place.id,
      ...(counted && counted.count > 0 ? { count: counted.count, words: counted.words, tone: counted.tone } : {}),
      ...(unread.length > 0 ? { unread: unread.sort() } : {}),
    };
  }));
}

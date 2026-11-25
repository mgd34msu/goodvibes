/**
 * source-notices.ts, which daemon change notices (LIST_CHANGED, runtime/list-changes.ts) name a daemon source.
 *
 * A notice names the list that changed (`memory`, `tools`, ...). A place list that names its notices
 * (`follows.lists`) hears those. One that names none hears the notices that name its source: those that another
 * declaration of the same source names (System's sign-in reads `local_auth.status`, which Permissions and safety
 * declares as changed by `safety`). A notice that names no source a list reads costs it no read.
 *
 * The source of a `capabilities.run` list is the capability it runs; any other daemon list's is its method and input.
 * Learned once from every place's declarations (`wirePlaces`); nothing here reaches the daemon.
 */
import type { AnyPlace, PlaceItem, PlaceSource } from './place-types.js';

/** The source a daemon list reads, as notices name it; undefined for a session or program source. */
export function daemonSourceKey(source: PlaceSource<PlaceItem>): string | undefined {
  if (source.kind !== 'daemon') return undefined;
  const id = (source.input as { readonly id?: unknown } | undefined)?.id;
  if (source.method === 'capabilities.run' && typeof id === 'string') return `capability ${id}`;
  // A method with its input: `config.get` of the payment addresses is not `config.get` of the Cloudflare settings.
  return `${source.method} ${JSON.stringify(source.input ?? {})}`;
}

let named = new Map<string, readonly string[]>();

/** Learn, from every place's declarations, which notices name each daemon source. */
export function learnSourceNotices(places: readonly AnyPlace[]): void {
  const next = new Map<string, Set<string>>();
  for (const place of places) {
    for (const list of place.lists) {
      const key = daemonSourceKey(list.source);
      const lists = list.follows?.lists ?? [];
      if (key === undefined || lists.length === 0) continue;
      const set = next.get(key) ?? new Set<string>();
      for (const name of lists) set.add(name);
      next.set(key, set);
    }
  }
  named = new Map([...next].map(([key, set]) => [key, [...set]]));
}

/** The notices that name this source (none when no declaration of it names any). */
export function noticesNaming(source: PlaceSource<PlaceItem>): readonly string[] {
  const key = daemonSourceKey(source);
  return key === undefined ? [] : named.get(key) ?? [];
}

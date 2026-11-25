/**
 * place-titles.ts, the titles a place showed for the things it lists (a piece of work by what you asked for), kept
 * by the daemon read that listed them, so an ask worded later (the card for a model's call that names a piece of
 * work by its id) names the thing as the place does. Kept per list as the places read; the newest read of a list
 * wins. Nothing here is read from the daemon: a thing no place has listed yet is named by its id, as before.
 */
import { listByName, pickedLabel } from '../command-actions/lists.js';

const PER_LIST = 500;
/** By daemon read (method and input), then by the place list that showed it (two lists can share one read). */
const titles = new Map<string, Map<string, Map<string, string>>>();

function sourceKey(method: string, input: unknown): string {
  return `${method} ${JSON.stringify(input)}`;
}

/** What one place list showed from one daemon read: each item's id and the title its row shows. */
export function rememberPlaceTitles(method: string, input: unknown, list: string, entries: readonly (readonly [string, string])[]): void {
  const kept = new Map<string, string>();
  for (const [id, title] of entries.slice(0, PER_LIST)) if (id && title && title !== id) kept.set(id, title);
  const key = sourceKey(method, input);
  const lists = titles.get(key) ?? new Map<string, Map<string, string>>();
  lists.set(list, kept);
  titles.set(key, lists);
}

/** The one title the remembered lists give `value`, when they agree. */
function agreed(lists: Iterable<Map<string, string>>, value: string): string | undefined {
  const seen = new Set<string>();
  for (const kept of lists) { const title = kept.get(value); if (title) seen.add(title); }
  return seen.size === 1 ? [...seen][0] : undefined;
}

/**
 * The title of `value` in the live list an input chooses from (`work.items`), as a place last showed it: the list's
 * own daemon read (its declared method and input) is the place's read of the same things. Undefined when no place
 * or form has shown it.
 */
export function listedTitle(list: string, value: string): string | undefined {
  let operator: ReturnType<typeof listByName>['operator'] | undefined;
  try { operator = listByName(list).operator; } catch { operator = undefined; }
  const shown = operator && 'method' in operator ? titles.get(sourceKey(operator.method, operator.input)) : undefined;
  const fromPlace = shown ? agreed(shown.values(), value) : undefined;
  if (fromPlace) return fromPlace;
  const picked = pickedLabel(list, value);
  if (picked !== value) return picked;
  // A list this program does not declare (its command lives in another program): the one title every place that
  // listed exactly this id showed for it.
  return agreed([...titles.values()].flatMap((lists) => [...lists.values()]), value);
}

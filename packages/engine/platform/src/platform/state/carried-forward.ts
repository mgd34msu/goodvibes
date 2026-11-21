/**
 * What this process's upgrade steps carried forward from an earlier version
 * (3.3.1's approvals and rules, 3.3.4's owed channel answers), said to the
 * owner once as one line ("Carried forward from the earlier version: 11
 * approvals, 1 remembered permission rule, ..."). Each step that reads an
 * earlier form and writes the current one notes what it carried; the notes of one start are
 * gathered for a moment and said together through the sink the daemon names
 * (its receipt store, shown on a terminal app's next connect). A process with
 * no sink says nothing: the daemon, which a service update starts first, is
 * the one that carries a home forward.
 *
 * Costs nothing on a start that carries nothing: no note, no timer.
 */

const counts = new Map<string, number>();
/** Changes the owner must act on, each said as its own line with this start's notes. */
const changes: string[] = [];
let sink: ((text: string) => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** How long the notes of one start are gathered before they are said together. */
const GATHER_MS = 3_000;

/** One kind of record an upgrade step carried, with its count ("approval", 11). Nouns are singular; the line pluralizes. */
export function noteCarriedForward(noun: string, count = 1): void {
  if (count <= 0) return;
  counts.set(noun, (counts.get(noun) ?? 0) + count);
  schedule();
}

/**
 * A change an upgrade step made that the owner has to act on, in one or two
 * sentences that say what to do ("webhook senders must now send ..."). Said
 * once, as its own line, through the same sink and at the same moment as the
 * counted notes. The step calls it only on the start that made the change.
 */
export function noteCarriedForwardChange(text: string): void {
  if (!text.trim() || changes.includes(text)) return;
  changes.push(text);
  schedule();
}

/** The daemon names where the line goes; notes made before it did are said then. */
export function sayCarriedForwardThrough(say: ((text: string) => void) | null): void {
  sink = say;
  schedule();
}

function schedule(): void {
  if (sink === null || (counts.size === 0 && changes.length === 0) || timer !== null) return;
  timer = setTimeout(flush, GATHER_MS);
  timer.unref?.();
}

/**
 * Say what is gathered now instead of when the gather ends: the daemon calls
 * this first thing as it stops, while its receipt store still takes the line,
 * so a process that ends within the gather window still says it. Nothing
 * happens with no notes or no sink.
 */
export function sayCarriedForwardNow(): void {
  if (timer !== null) clearTimeout(timer);
  flush();
}

function flush(): void {
  timer = null;
  if (sink === null) return;
  if (counts.size > 0) {
    const parts = [...counts].map(([noun, count]) => `${count} ${count === 1 ? noun : `${noun}s`}`);
    counts.clear();
    try { sink(`Carried forward from the earlier version: ${parts.join(', ')}.`); } catch { /* the receipt store reports its own failure */ }
  }
  for (const change of changes.splice(0)) {
    try { sink(change); } catch { /* the receipt store reports its own failure */ }
  }
}

/**
 * refused-from-group.ts, what this machine refused from another machine of its group because it claimed the owner's
 * identity without the owner's own recorded act (gate-review-6 G2): a new password for the owner's account, or a device marked
 * as the owner's own device, written on another machine where the owner did not make it. Kept in memory for this run (the newest
 * twenty, one line per refused version), logged as it happens, and shown by `cluster.status` and the Machine group tab.
 * Never a value, a hash or a token: what was refused, from which machine's record, and when.
 */

/** One refused change from the group. */
export interface RefusedFromGroup {
  /** What was refused, in the owner's words ("a new password for your account admin"). */
  readonly what: string;
  /** The record id of the machine that wrote it (authority-record.ts `origin`). */
  readonly origin: string;
  readonly at: number;
}

const KEPT = 20;
const refused: RefusedFromGroup[] = [];
const seen = new Set<string>();

/**
 * Note one refused change, once per `key` (the version refused: its record key and revision), newest first. Returns
 * whether it was new, so the caller logs it once.
 */
export function noteRefusedFromGroup(key: string, entry: RefusedFromGroup): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  refused.unshift(entry);
  if (refused.length > KEPT) refused.length = KEPT;
  if (seen.size > KEPT * 10) seen.clear();
  return true;
}

/** The refused changes noted in this run, newest first. */
export function refusedFromGroup(): readonly RefusedFromGroup[] {
  return [...refused];
}

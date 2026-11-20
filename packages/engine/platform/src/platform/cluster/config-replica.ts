/**
 * config-replica.ts, the replicated settings document, and how two copies of
 * it are reconciled.
 *
 * ── ORDERING IS NOT A CLOCK ────────────────────────────────────────────────
 *
 * Nothing here compares timestamps to decide what wins. Two homelab machines
 * routinely disagree about the time by minutes, neither is obliged to run NTP,
 * and a last-write-wins rule keyed on wall clock would let the machine with the
 * fastest clock win every conflict permanently, including winning against a
 * deletion made afterwards on a correct clock.
 *
 * Ordering is a REVISION: every member issues the next revision above the
 * highest it has seen, for the changes made on it. Higher revision wins. At an
 * equal revision, which two members writing at once produce, a deletion beats
 * a write, and two writes are settled by origin node id so every copy lands on
 * the same answer without negotiating.
 *
 * `at` is recorded because an operator reading `cluster status` wants to know
 * when something changed. It is never consulted to decide what wins, and it
 * must not start being.
 */

import { createHash } from 'node:crypto';

/** One replicated setting. */
export interface ConfigReplicaEntry {
  readonly path: string;
  /** JSON value for a config path; for a secret, the ciphertext is never here. */
  readonly value: unknown;
  readonly revision: number;
  /** The node that originated the change, logged, and the equal-revision tiebreak. */
  readonly origin: string;
  /** Wall clock, for display only. Never used for ordering. */
  readonly at: number;
  /** True when the value lives in the secret store rather than in config. */
  readonly secret: boolean;
}

/**
 * A deletion.
 *
 * The same discipline the roster uses for a removed machine, and for the same
 * reason: absence is indistinguishable from "not learned yet", so a deletion has
 * to be a positive fact that survives a merge. Without this, a machine that was
 * partitioned when the operator deleted a surface would helpfully put it back.
 */
export interface ConfigReplicaTombstone {
  readonly path: string;
  readonly revision: number;
  readonly origin: string;
  readonly at: number;
  readonly secret: boolean;
}

export interface ConfigReplicaDocument {
  readonly version: 1;
  readonly groupId: string;
  /** Highest revision this copy has issued or seen. */
  readonly revision: number;
  readonly entries: readonly ConfigReplicaEntry[];
  readonly tombstones: readonly ConfigReplicaTombstone[];
  /**
   * LOCAL ONLY: per path, the revision whose effect is on THIS machine (the
   * setting written, the credential stored, the deletion made). Saved in the
   * same file write as the document and read back with it, never sent and
   * never merged (`wireReplicaDocument` strips it). An entry or deletion above
   * it is a change still to apply here, so a change lost to a restart between
   * saving the document and applying it is applied on the next pass, and a
   * credential counts as held only for the revision it was stored under.
   */
  readonly applied?: Readonly<Record<string, number>> | undefined;
}

/** The document as it goes on the wire: without this machine's applied state. */
export function wireReplicaDocument(document: ConfigReplicaDocument): ConfigReplicaDocument {
  if (document.applied === undefined) return document;
  return { version: 1, groupId: document.groupId, revision: document.revision, entries: document.entries, tombstones: document.tombstones };
}

/** The revision whose effect is on this machine for `path`, or -1. */
export function appliedRevision(document: ConfigReplicaDocument, path: string): number {
  return document.applied?.[path] ?? -1;
}

/** Record that the effect of `revision` for each path is on this machine. */
export function withApplied(document: ConfigReplicaDocument, applied: Readonly<Record<string, number>>): ConfigReplicaDocument {
  const next: Record<string, number> = { ...document.applied };
  let changed = false;
  for (const [path, revision] of Object.entries(applied)) {
    // Revisions only grow: an effect recorded for a newer revision stays.
    if ((next[path] ?? -1) >= revision) continue;
    next[path] = revision;
    changed = true;
  }
  return changed ? { ...document, applied: next } : document;
}

/**
 * Bounds. Persisted, replicated state that can only grow is a slow leak, and
 * one that arrives over the network is a leak someone else can drive.
 */
export const MAX_REPLICATED_ENTRIES = 512;
export const MAX_REPLICATED_TOMBSTONES = 256;
export const CONFIG_TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
/** A single replicated value, serialized. Comfortably past any real setting. */
export const MAX_REPLICATED_VALUE_BYTES = 16 * 1024;

/**
 * How far past its own revision a copy accepts one incoming document. A real
 * group moves a handful of revisions at a time, and a huge number is a way to
 * make one entry beat every later write: the counter is a float, and the next
 * legitimate revision rounds back onto the same value.
 */
export const MAX_REVISION_ADVANCE = 100_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRevision(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && Number.isSafeInteger(Math.trunc(value));
}

/** True when a value is small enough and plain enough to replicate. */
export function isReplicableValue(value: unknown): boolean {
  if (value === undefined) return false;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return false;
  }
  return serialized.length > 0 && serialized.length <= MAX_REPLICATED_VALUE_BYTES;
}

function readEntry(value: unknown): ConfigReplicaEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['path'] !== 'string' || candidate['path'].length === 0) return null;
  if (!isRevision(candidate['revision'])) return null;
  if (typeof candidate['origin'] !== 'string') return null;
  if (!isReplicableValue(candidate['value'])) return null;
  return {
    path: candidate['path'],
    value: candidate['value'],
    revision: Math.trunc(candidate['revision']),
    origin: candidate['origin'],
    at: isFiniteNumber(candidate['at']) ? Math.trunc(candidate['at']) : 0,
    secret: candidate['secret'] === true,
  };
}

function readTombstone(value: unknown): ConfigReplicaTombstone | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['path'] !== 'string' || candidate['path'].length === 0) return null;
  if (!isRevision(candidate['revision'])) return null;
  if (typeof candidate['origin'] !== 'string') return null;
  return {
    path: candidate['path'],
    revision: Math.trunc(candidate['revision']),
    origin: candidate['origin'],
    at: isFiniteNumber(candidate['at']) ? Math.trunc(candidate['at']) : 0,
    secret: candidate['secret'] === true,
  };
}

/** An empty document for a group that has replicated nothing yet. */
export function createConfigReplicaDocument(groupId: string): ConfigReplicaDocument {
  return { version: 1, groupId, revision: 0, entries: [], tombstones: [] };
}

/**
 * Parse an untrusted document, off the wire, or off disk after a crash.
 *
 * `keep` is the replication policy. Filtering on the RECEIVE side as well as
 * the send side is the point: a peer running a different build, or a modified
 * one, does not get to decide what this machine will apply to its own config.
 */
export function readConfigReplicaDocument(
  value: unknown,
  keep: (path: string) => boolean,
): ConfigReplicaDocument | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== 1) return null;
  if (typeof candidate['groupId'] !== 'string' || candidate['groupId'].length === 0) return null;
  const entries = (Array.isArray(candidate['entries']) ? candidate['entries'] : [])
    .map(readEntry)
    .filter((entry): entry is ConfigReplicaEntry => entry !== null && keep(entry.path));
  const tombstones = (Array.isArray(candidate['tombstones']) ? candidate['tombstones'] : [])
    .map(readTombstone)
    .filter((entry): entry is ConfigReplicaTombstone => entry !== null && keep(entry.path));
  const revision = isFiniteNumber(candidate['revision']) ? Math.max(0, Math.trunc(candidate['revision'])) : 0;
  if (!Number.isSafeInteger(revision)) return null;
  const applied: Record<string, number> = {};
  const rawApplied = candidate['applied'];
  if (typeof rawApplied === 'object' && rawApplied !== null && !Array.isArray(rawApplied)) {
    for (const [path, value] of Object.entries(rawApplied as Record<string, unknown>)) if (keep(path) && isRevision(value)) applied[path] = Math.trunc(value);
  }
  return normalize({
    version: 1,
    groupId: candidate['groupId'],
    revision,
    entries,
    tombstones,
    ...(Object.keys(applied).length > 0 ? { applied } : {}),
  });
}

/**
 * Deduplicate and order so two copies holding the same facts serialize
 * identically, and apply the tombstone rule.
 */
function normalize(document: ConfigReplicaDocument): ConfigReplicaDocument {
  const entries = new Map<string, ConfigReplicaEntry>();
  for (const entry of document.entries) {
    const existing = entries.get(entry.path);
    if (!existing || beats(entry, existing)) entries.set(entry.path, entry);
  }
  const tombstones = new Map<string, ConfigReplicaTombstone>();
  for (const tombstone of document.tombstones) {
    const existing = tombstones.get(tombstone.path);
    // Equal revisions are settled by origin, like entries, so two copies that
    // saw the same two deletions in a different order keep the same one.
    if (!existing || tombstone.revision > existing.revision
      || (tombstone.revision === existing.revision && tombstone.origin < existing.origin)) tombstones.set(tombstone.path, tombstone);
  }
  // A deletion at or above an entry's revision removes it. Equal resolves to
  // DELETED, see the header: only two members writing at once produce a tie, and
  // resolving toward the deletion is the only direction that cannot resurrect
  // something the operator removed.
  // A deletion BELOW an entry's revision is history: the setting was written
  // again after it, and keeping the record would make the path look deleted.
  for (const [path, tombstone] of tombstones) {
    const entry = entries.get(path);
    if (!entry) continue;
    if (tombstone.revision >= entry.revision) entries.delete(path);
    else tombstones.delete(path);
  }
  const bounded = [...entries.values()].sort(byPath).slice(0, MAX_REPLICATED_ENTRIES);
  // Applied state is kept only for paths the document still holds.
  let applied = document.applied;
  if (applied) {
    const held = new Set([...bounded.map((entry) => entry.path), ...tombstones.keys()]);
    if (Object.keys(applied).some((path) => !held.has(path))) applied = Object.fromEntries(Object.entries(applied).filter(([path]) => held.has(path)));
  }
  return {
    ...document,
    ...(applied !== document.applied ? { applied } : {}),
    revision: Math.max(
      document.revision,
      ...bounded.map((entry) => entry.revision),
      ...[...tombstones.values()].map((entry) => entry.revision),
      0,
    ),
    entries: bounded,
    tombstones: [...tombstones.values()].sort(byPath),
  };
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Higher revision wins; an equal revision is settled by origin, never by clock. */
function beats(candidate: ConfigReplicaEntry, incumbent: ConfigReplicaEntry): boolean {
  if (candidate.revision !== incumbent.revision) return candidate.revision > incumbent.revision;
  return candidate.origin < incumbent.origin;
}

/**
 * Reconcile two copies. Commutative in what it selects: the merge order does
 * not change the entries and deletions. The applied state is LOCAL's (it says
 * what is on this machine), never the remote copy's.
 */
export function mergeConfigReplica(
  local: ConfigReplicaDocument,
  remote: ConfigReplicaDocument,
): ConfigReplicaDocument {
  if (local.groupId !== remote.groupId) return local;
  return normalize({
    version: 1,
    groupId: local.groupId,
    revision: Math.max(local.revision, remote.revision),
    entries: [...local.entries, ...remote.entries],
    tombstones: [...local.tombstones, ...remote.tombstones],
    ...(local.applied !== undefined ? { applied: local.applied } : {}),
  });
}

/** Write (or overwrite) a setting at the next revision. */
export function putReplicaEntry(
  document: ConfigReplicaDocument,
  input: { path: string; value: unknown; origin: string; at: number; secret?: boolean },
): ConfigReplicaDocument {
  const revision = document.revision + 1;
  return normalize({
    ...document,
    revision,
    entries: [
      ...document.entries.filter((entry) => entry.path !== input.path),
      {
        path: input.path,
        value: input.value,
        revision,
        origin: input.origin,
        at: Math.trunc(input.at),
        secret: input.secret === true,
      },
    ],
    // A re-write clears any earlier deletion of the same path, at a revision
    // above it, so the write is what survives the next merge.
    tombstones: document.tombstones.filter((entry) => entry.path !== input.path),
  });
}

/** Delete a setting at the next revision. */
export function deleteReplicaEntry(
  document: ConfigReplicaDocument,
  input: { path: string; origin: string; at: number; secret?: boolean },
): ConfigReplicaDocument {
  const revision = document.revision + 1;
  return normalize({
    ...document,
    revision,
    entries: document.entries.filter((entry) => entry.path !== input.path),
    tombstones: [
      ...document.tombstones.filter((entry) => entry.path !== input.path),
      {
        path: input.path,
        revision,
        origin: input.origin,
        at: Math.trunc(input.at),
        secret: input.secret === true,
      },
    ],
  });
}

export interface ConfigReplicaSweepResult {
  readonly document: ConfigReplicaDocument;
  readonly droppedTombstones: number;
}

/**
 * Bound the document.
 *
 * Deletions expire after {@link CONFIG_TOMBSTONE_MAX_AGE_MS} and are capped,
 * oldest first. Expiring one is safe for the same reason it is safe in the
 * roster: the deletion has already been applied everywhere that is still
 * talking, and the tombstone's only job is to outlive a partition, 90 days is
 * far longer than any partition that ends in a heal rather than a rebuild.
 */
export function sweepConfigReplica(
  document: ConfigReplicaDocument,
  now: number,
): ConfigReplicaSweepResult {
  const cutoff = now - CONFIG_TOMBSTONE_MAX_AGE_MS;
  // `at` comes from the node that deleted the setting. One that sent none reads
  // as 0, and treating that as ancient would drop the deletion at the first
  // sweep and let a partitioned copy bring the setting back. An unknown age is
  // kept, and is the first thing the cap below removes.
  const fresh = document.tombstones.filter((entry) => entry.at <= 0 || entry.at >= cutoff);
  const kept = fresh.length <= MAX_REPLICATED_TOMBSTONES
    ? fresh
    : [...fresh].sort((a, b) => b.at - a.at).slice(0, MAX_REPLICATED_TOMBSTONES);
  if (kept.length === document.tombstones.length) return { document, droppedTombstones: 0 };
  return {
    document: normalize({ ...document, tombstones: kept }),
    droppedTombstones: document.tombstones.length - kept.length,
  };
}

/** The entry for a path, or null. */
export function findReplicaEntry(
  document: ConfigReplicaDocument,
  path: string,
): ConfigReplicaEntry | null {
  return document.entries.find((entry) => entry.path === path) ?? null;
}

/**
 * A short fingerprint of what a copy holds: every entry and deletion by path,
 * revision and origin. Two copies with equal fingerprints hold the same
 * settings, which the revision number alone cannot show (two members can each
 * issue the same revision for different changes). A value is not part of it:
 * one origin issues one revision once, so path, revision and origin name it.
 */
export function replicaDigest(document: ConfigReplicaDocument): string {
  const hash = createHash('sha256');
  for (const entry of document.entries) hash.update(`e\0${entry.path}\0${entry.revision}\0${entry.origin}\0${entry.secret ? 1 : 0}\n`);
  for (const entry of document.tombstones) hash.update(`t\0${entry.path}\0${entry.revision}\0${entry.origin}\0${entry.secret ? 1 : 0}\n`);
  return hash.digest('hex').slice(0, 32);
}

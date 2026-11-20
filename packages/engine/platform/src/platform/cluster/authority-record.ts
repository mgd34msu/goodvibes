/**
 * authority-record.ts, the one record that says which keys, credentials and
 * grants are current and which are revoked, on every node.
 *
 * Pure: types, merge, digest and views. No I/O (authority-record-file.ts
 * owns the file; authority-sync.ts carries it between machines).
 *
 * THE RULE. Whether a credential is current is answered from this record, and
 * nothing else on a node holds a copy that can say yes. A revocation is a
 * terminal entry, never a deletion: absence is indistinguishable from "not
 * learned yet", so a deletion could be undone by a machine that was away.
 *
 * The merge extends two rule sets that already exist: the roster's "a removal
 * is a positive record that beats an add at equal generation"
 * (group-state.ts) and the settings replica's "order by revision, never by
 * clock; equal revision settles by origin" (config-replica.ts). Every rule is
 * a max or a terminal flag, so the merge is commutative, associative and
 * idempotent: joins, revocations and restarts arriving in any order end on
 * the same record. `at` fields are for display and are never compared.
 */
import { createHash } from 'node:crypto';

export type AuthorityKind =
  | 'member'
  | 'key-epoch'
  | 'device-token'
  | 'user'
  | 'peer-token'
  | 'device-grant'
  | 'relay-route'
  | 'push-endpoint'
  | 'passkey'
  | 'budget-spend'
  | 'occasion-state'
  | 'job'
  | 'group';

export const AUTHORITY_KINDS: readonly AuthorityKind[] = Object.freeze([
  'member', 'key-epoch', 'device-token', 'user', 'peer-token', 'device-grant', 'relay-route', 'push-endpoint', 'passkey',
  'budget-spend', 'occasion-state', 'job', 'group',
]);

/** `${kind}:${id}`. An id is never reused: re-issuing is a new id. */
export type AuthorityKey = `${AuthorityKind}:${string}`;

export function authorityKey(kind: AuthorityKind, id: string): AuthorityKey {
  return `${kind}:${id}`;
}

export interface AuthorityRevocation {
  readonly rev: number;
  /** Node that wrote the revocation. */
  readonly origin: string;
  /** Display only, never compared. */
  readonly at: number;
  /** Principal id that asked. */
  readonly by: string;
  /** Plain words, shown in lists. */
  readonly reason: string;
}

/**
 * Who a credential is good for: every daemon of the group this record
 * belongs to (the default, owner decision D3), or one node only. A record that
 * belongs to no group is the group of one, so 'group' entries made before a
 * join stay good in the group joined (owner decision D2).
 */
export type AuthorityAudience = 'group' | { readonly nodeId: string };

export interface AuthorityPublicParts {
  member: { readonly nodeId: string; readonly gen: number; readonly displayName: string; readonly identityKey: string; readonly agreementKey: string; readonly admittedAt: number; readonly removedUnder?: string;
    /** The record id (origin) of this member's daemon home, bound by `originProof` (its identity key's signature); see group-state.ts. */
    readonly authorityOrigin?: string; readonly originProof?: string;
    /** Written with the removal: entries from `authorityOrigin` above this revision are refused (rule 7). */
    readonly originCutoff?: number };
  'key-epoch': { readonly epoch: number; readonly cause: 'scheduled' | 'revocation'; readonly mintedBy: string; readonly createdAt: number; readonly keyCommitment: string; readonly signing: { readonly publicKey: string; readonly generation: number }; readonly joinVerifier: string };
  'device-token': { readonly name: string; readonly tokenHash: string; readonly createdAt: number; readonly client: 'device' | 'agent'; readonly scopes: readonly string[] | null; readonly rotationIssuedAt: number; readonly [extra: string]: unknown };
  user: { readonly username: string; readonly roles: readonly string[]; readonly scopes: readonly string[] | null; readonly epoch: number; readonly createdAt: number };
  'peer-token': { readonly peerId: string; readonly label: string; readonly tokenHash: string; readonly scopes: readonly string[]; readonly issuedAt: number; readonly [extra: string]: unknown };
  'device-grant': { readonly nodeId: string; readonly nodeKind: string; readonly capabilityId: string; readonly scope: 'always' | 'session'; readonly sessionId: string | null; readonly expiresAt: number | null; readonly grantedBy: string; readonly [extra: string]: unknown };
  /** One device's relay code; `deviceKey` is the paired device it was issued to, null when the owner's machine minted it. */
  'relay-route': { readonly routeHash: string; readonly deviceKey: AuthorityKey | null; readonly label: string };
  'push-endpoint': { readonly endpointHash: string; readonly principalId: string; readonly label: string; readonly createdAt: number; readonly deviceId?: string | undefined };
  /**
   * A step-up passkey (WebAuthn credential) that confirms relayed actions, with
   * the relying-party policy it was registered under. The public key is not a
   * secret; the signature counter is kept per machine, not here.
   */
  passkey: { readonly credentialId: string; readonly publicKeyCose: string; readonly label: string; readonly createdAt: number; readonly signCount: number; readonly rpId: string; readonly origins: readonly string[]; readonly userVerification: 'required' | 'preferred' | 'discouraged' };
  /**
   * What the group spent on one day from one pool, as one counter per node
   * that spent (a grow-only map: each node only ever raises its own slot, so
   * the group's total is the sum and no spend is counted twice or lost).
   */
  'budget-spend': { readonly dayKey: string; readonly currency: string; readonly spentByNode: Readonly<Record<string, Readonly<Record<string, number>>>> };
  /** One occasion's answered state, the same on every node. */
  'occasion-state': { readonly occasionId: string; readonly state: Readonly<Record<string, unknown>> };
  /**
   * One schedule, watcher or reminder job definition, run once in the group by
   * the holder of the automation role. `lastOccurrenceAt` is the planned time
   * of the last occurrence a holder started (0 before the first): a holder
   * writes it BEFORE it starts the run, so the next holder neither runs that
   * occurrence again nor skips the one after it. It only rises (see mergeEntry).
   */
  job: { readonly family: 'automation' | 'watcher'; readonly definition: Readonly<Record<string, unknown>>; readonly lastOccurrenceAt: number };
  /** A LAN group's own facts: its display name, which the beacon shows. Id: the group id. */
  group: { readonly groupId: string; readonly displayName: string };
}

export interface AuthorityPrivateParts {
  member: never;
  'key-epoch': never;
  'device-token': never;
  user: { readonly passwordHash: string };
  'peer-token': never;
  'device-grant': never;
  'relay-route': never;
  'push-endpoint': { readonly endpoint: string; readonly p256dh: string; readonly auth: string };
  passkey: never;
  'budget-spend': never;
  'occasion-state': never;
  job: never;
  group: never;
}

export interface AuthorityEntry<K extends AuthorityKind = AuthorityKind> {
  readonly kind: K;
  readonly id: string;
  /** Record revision that wrote this version (Lamport: one above the highest seen). */
  readonly rev: number;
  /** Revision of the last change that narrowed or widened authority. A rename does not move it. */
  readonly authorityRev: number;
  readonly origin: string;
  /** Display only, never compared. */
  readonly at: number;
  readonly audience: AuthorityAudience;
  /** Revoking the parent revokes this entry, computed at read time, never copied. */
  readonly parent: AuthorityKey | null;
  /** Terminal. Once set on any copy it is set on every merge result. */
  readonly revoked: AuthorityRevocation | null;
  readonly public: AuthorityPublicParts[K];
  /** Kept in the record file (0600); sealed per member on the wire, never sent in clear. */
  readonly private: AuthorityPrivateParts[K] | null;
}

export type AnyAuthorityEntry = { [K in AuthorityKind]: AuthorityEntry<K> }[AuthorityKind];

export type AuthorityScope = { readonly groupId: string } | { readonly groupId: null; readonly nodeId: string };

export interface AuthorityRecord {
  readonly version: 1;
  readonly scope: AuthorityScope;
  /** Highest revision issued or seen. */
  readonly revision: number;
  /** Max of every 'key-epoch' with cause 'revocation'; a generation at or below it is never reopened. */
  readonly revocationFloor: number;
  /** Per origin, the revision through which revoked entries were dropped everywhere. */
  readonly compacted: Readonly<Record<string, number>>;
  readonly entries: ReadonlyMap<AuthorityKey, AnyAuthorityEntry>;
}

export interface AuthorityHead { readonly revision: number; readonly digest: string }

/** A credential as it was when work was admitted under it; see `isCurrent`. */
export interface AuthorityRef { readonly key: AuthorityKey; readonly authorityRev: number }

/** The serialized record: entries as an array, ordered by key. */
export interface AuthorityRecordWire {
  readonly version: 1;
  readonly scope: AuthorityScope;
  readonly revision: number;
  readonly revocationFloor: number;
  readonly compacted: Readonly<Record<string, number>>;
  readonly entries: readonly AnyAuthorityEntry[];
}

export function emptyAuthorityRecord(scope: AuthorityScope): AuthorityRecord {
  return { version: 1, scope, revision: 0, revocationFloor: 0, compacted: {}, entries: new Map() };
}

export function keyOf(entry: { readonly kind: AuthorityKind; readonly id: string }): AuthorityKey {
  return authorityKey(entry.kind, entry.id);
}

// ── validation ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readRevocation(value: unknown): AuthorityRevocation | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !nonNegativeInteger(value['rev']) || typeof value['origin'] !== 'string') return undefined;
  return {
    rev: value['rev'],
    origin: value['origin'],
    at: typeof value['at'] === 'number' && Number.isFinite(value['at']) ? value['at'] : 0,
    by: typeof value['by'] === 'string' ? value['by'] : '',
    reason: typeof value['reason'] === 'string' ? value['reason'].slice(0, 200) : '',
  };
}

function readAudience(value: unknown): AuthorityAudience | undefined {
  if (value === 'group') return 'group';
  if (isRecord(value) && typeof value['nodeId'] === 'string' && value['nodeId'].length > 0) return { nodeId: value['nodeId'] };
  return undefined;
}

/** Parse one untrusted entry (from disk or the wire). Malformed entries are dropped one by one. */
export function readAuthorityEntry(value: unknown): AnyAuthorityEntry | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !(AUTHORITY_KINDS as readonly string[]).includes(kind)) return null;
  const id = value['id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return null;
  if (!nonNegativeInteger(value['rev']) || !nonNegativeInteger(value['authorityRev'])) return null;
  if (typeof value['origin'] !== 'string' || value['origin'].length === 0) return null;
  const audience = readAudience(value['audience']);
  if (audience === undefined) return null;
  const parent = value['parent'];
  if (parent !== null && (typeof parent !== 'string' || !parent.includes(':'))) return null;
  const revoked = readRevocation(value['revoked'] ?? null);
  if (revoked === undefined) return null;
  if (!isRecord(value['public'])) return null;
  const privatePart = value['private'];
  if (privatePart !== null && privatePart !== undefined && !isRecord(privatePart)) return null;
  return {
    kind: kind as AuthorityKind,
    id,
    rev: value['rev'],
    authorityRev: value['authorityRev'],
    origin: value['origin'],
    at: typeof value['at'] === 'number' && Number.isFinite(value['at']) ? value['at'] : 0,
    audience,
    parent: parent as AuthorityKey | null,
    revoked,
    public: value['public'],
    private: (privatePart ?? null),
  } as AnyAuthorityEntry;
}

export function readAuthorityRecord(value: unknown): AuthorityRecord | null {
  if (!isRecord(value) || value['version'] !== 1) return null;
  const scopeValue = value['scope'];
  let scope: AuthorityScope;
  if (isRecord(scopeValue) && typeof scopeValue['groupId'] === 'string' && scopeValue['groupId'].length > 0) scope = { groupId: scopeValue['groupId'] };
  else if (isRecord(scopeValue) && scopeValue['groupId'] === null && typeof scopeValue['nodeId'] === 'string') scope = { groupId: null, nodeId: scopeValue['nodeId'] };
  else return null;
  const compacted: Record<string, number> = {};
  if (isRecord(value['compacted'])) {
    for (const [origin, rev] of Object.entries(value['compacted'])) if (nonNegativeInteger(rev)) compacted[origin] = rev;
  }
  const entries = new Map<AuthorityKey, AnyAuthorityEntry>();
  for (const raw of Array.isArray(value['entries']) ? value['entries'] : []) {
    const entry = readAuthorityEntry(raw);
    if (!entry) continue;
    const key = keyOf(entry);
    const existing = entries.get(key);
    entries.set(key, existing ? mergeEntry(existing, entry) : entry);
  }
  let revision = nonNegativeInteger(value['revision']) ? value['revision'] : 0;
  for (const entry of entries.values()) revision = Math.max(revision, entry.rev, entry.revoked?.rev ?? 0);
  return {
    version: 1,
    scope,
    revision,
    revocationFloor: nonNegativeInteger(value['revocationFloor']) ? value['revocationFloor'] : 0,
    compacted,
    entries,
  };
}

export function toAuthorityWire(record: AuthorityRecord): AuthorityRecordWire {
  return {
    version: 1,
    scope: record.scope,
    revision: record.revision,
    revocationFloor: record.revocationFloor,
    compacted: sortedObject(record.compacted),
    entries: [...record.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry),
  };
}

// ── merge ───────────────────────────────────────────────────────────────────

/** Compare two (rev, origin) pairs: positive when `a` is the later write. Equal rev: the smaller origin wins. */
function laterWrite(a: { rev: number; origin: string }, b: { rev: number; origin: string }): number {
  if (a.rev !== b.rev) return a.rev - b.rev;
  if (a.origin === b.origin) return 0;
  return a.origin < b.origin ? 1 : -1;
}

/** The revocation every node keeps: the smaller (rev, origin) of the two. */
function earlierRevocation(a: AuthorityRevocation, b: AuthorityRevocation): AuthorityRevocation {
  if (a.rev !== b.rev) return a.rev < b.rev ? a : b;
  return a.origin <= b.origin ? a : b;
}

/** Two versions of one entry, merged by rules 1 to 3. */
export function mergeEntry(a: AnyAuthorityEntry, b: AnyAuthorityEntry): AnyAuthorityEntry {
  // Rule 3: two candidates for one key epoch (a partition minted twice) settle
  // on the smaller minter, whatever the revisions. A revocation on either copy
  // stays terminal (rule 1), so the result does not depend on which copy won.
  if (a.kind === 'key-epoch' && b.kind === 'key-epoch' && a.public.mintedBy !== b.public.mintedBy) {
    const kept = a.public.mintedBy < b.public.mintedBy ? a : b;
    const revocation = a.revoked && b.revoked ? earlierRevocation(a.revoked, b.revoked) : a.revoked ?? b.revoked;
    return kept.revoked === revocation ? kept : { ...kept, revoked: revocation };
  }
  // Rule 2: the later (rev, origin) version carries the public part.
  const order = laterWrite(a, b);
  let winner = order >= 0 ? a : b;
  const loser = winner === a ? b : a;
  // A day's spend is a grow-only counter per node: every node raises only its
  // own slots, so two versions merge slot by slot by max, and a spend made on
  // one machine is never lost to a later write on another.
  if (a.kind === 'budget-spend' && b.kind === 'budget-spend') {
    const spentByNode: Record<string, Record<string, number>> = {};
    for (const source of [a.public.spentByNode, b.public.spentByNode]) {
      for (const [node, pools] of Object.entries(source)) {
        const slot = spentByNode[node] ?? (spentByNode[node] = {});
        for (const [pool, amount] of Object.entries(pools)) slot[pool] = Math.max(slot[pool] ?? 0, amount);
      }
    }
    winner = { ...winner, public: { ...(winner as AuthorityEntry<'budget-spend'>).public, spentByNode } } as AnyAuthorityEntry;
  }
  // A job's last started occurrence only rises: an edit written on another
  // machine from a copy that had not yet heard of the latest start carries the
  // edit, never an older occurrence that would let it run a second time.
  if (a.kind === 'job' && b.kind === 'job') {
    const lastOccurrenceAt = Math.max(a.public.lastOccurrenceAt || 0, b.public.lastOccurrenceAt || 0);
    const kept = winner as AuthorityEntry<'job'>;
    if ((kept.public.lastOccurrenceAt || 0) !== lastOccurrenceAt) winner = { ...kept, public: { ...kept.public, lastOccurrenceAt } } as AnyAuthorityEntry;
  }
  // A version that arrived without its private part (not sealed to this node)
  // keeps the private part of the same version held here.
  const sameVersion = winner.rev === loser.rev && winner.origin === loser.origin;
  const privatePart = winner.private ?? (sameVersion ? loser.private : null);
  // Rule 1: a revocation on either copy is terminal.
  const revoked = a.revoked && b.revoked ? earlierRevocation(a.revoked, b.revoked) : a.revoked ?? b.revoked;
  if (winner.private === privatePart && winner.revoked === revoked) return winner;
  return { ...winner, private: privatePart, revoked } as AnyAuthorityEntry;
}

export interface AuthorityMergeOptions {
  /**
   * Rule 7: whether an entry written by `origin` may enter from the wire. The
   * carriage passes "is a current member"; a merge of local writes passes nothing.
   */
  readonly acceptOrigin?: ((origin: string) => boolean) | undefined;
  /**
   * `remote` is a few entries (a delta), not a whole record: an entry it does
   * not carry says nothing, so rule 6 drops only what arrives from it, never
   * an entry held here that the delta simply did not include.
   */
  readonly partial?: boolean | undefined;
  /**
   * Rule 7, per entry: given merged entries, a check every VERSION of every
   * entry (local and remote) passes through before versions are merged, so a
   * later version a writer was not entitled to is refused while its earlier
   * version stands. It returns the version, the version without a revocation
   * its writer was not entitled to, or null to refuse it. A function of the
   * merged record alone, so the result does not depend on arrival order.
   * Null: rule 7 is not in force for this record.
   */
  readonly admit?: ((entries: ReadonlyMap<AuthorityKey, AnyAuthorityEntry>) => ((entry: AnyAuthorityEntry) => AnyAuthorityEntry | null) | null) | undefined;
}

/**
 * Merge two copies. The result's scope is `local`'s (the carriage rescopes a
 * record on join; see `rescopeAuthorityRecord`).
 */
export function mergeAuthority(local: AuthorityRecord, remote: AuthorityRecord, options: AuthorityMergeOptions = {}): AuthorityRecord {
  const compacted: Record<string, number> = { ...local.compacted };
  for (const [origin, rev] of Object.entries(remote.compacted)) compacted[origin] = Math.max(compacted[origin] ?? 0, rev);
  const mergeWith = (admitVersion: ((entry: AnyAuthorityEntry) => AnyAuthorityEntry | null) | null): Map<AuthorityKey, AnyAuthorityEntry> => {
    const merged = new Map<AuthorityKey, AnyAuthorityEntry>();
    const consider = (entry: AnyAuthorityEntry, fromRemote: boolean): void => {
      if (fromRemote && options.acceptOrigin && !options.acceptOrigin(entry.origin)) return;
      const admitted = admitVersion ? admitVersion(entry) : entry;
      if (admitted === null) return;
      const key = keyOf(admitted);
      const existing = merged.get(key);
      merged.set(key, existing ? mergeEntry(existing, admitted) : admitted);
    };
    for (const entry of local.entries.values()) consider(entry, false);
    for (const entry of remote.entries.values()) consider(entry, true);
    // Rule 6: an entry present in only one copy at or below its origin's
    // compaction mark was revoked and dropped everywhere; it does not come back.
    for (const [key, entry] of merged) {
      const inLocal = local.entries.has(key), inRemote = remote.entries.has(key);
      if (inLocal !== inRemote && !(options.partial && inLocal) && entry.rev <= (compacted[entry.origin] ?? -1)) merged.delete(key);
    }
    return merged;
  };
  let entries = mergeWith(null);
  // Rule 7 per entry: who may write is read from the merged membership, and
  // read again from the result, so a member entry refused in the first pass
  // grants nothing in the second.
  for (let pass = 0; options.admit && pass < 2; pass += 1) {
    const admitVersion = options.admit(entries);
    if (!admitVersion) break;
    entries = mergeWith(admitVersion);
  }
  let revision = Math.max(local.revision, remote.revision);
  for (const entry of entries.values()) revision = Math.max(revision, entry.rev, entry.revoked?.rev ?? 0);
  return {
    version: 1,
    scope: local.scope,
    revision,
    revocationFloor: Math.max(local.revocationFloor, remote.revocationFloor, floorFrom(entries)),
    compacted,
    entries,
  };
}

function floorFrom(entries: ReadonlyMap<AuthorityKey, AnyAuthorityEntry>): number {
  let floor = 0;
  for (const entry of entries.values()) {
    if (entry.kind === 'key-epoch' && entry.public.cause === 'revocation') floor = Math.max(floor, entry.public.epoch);
  }
  return floor;
}

/** Move a record into a group's scope (a join). Nothing is removed (owner decision D2). */
export function rescopeAuthorityRecord(record: AuthorityRecord, scope: AuthorityScope): AuthorityRecord {
  return { ...record, scope };
}

// ── writes ──────────────────────────────────────────────────────────────────

/** An entry to issue: the record assigns rev, authorityRev, origin and at. */
export type AuthorityDraft = { [K in AuthorityKind]: {
  readonly kind: K;
  readonly id: string;
  readonly audience?: AuthorityAudience | undefined;
  readonly parent?: AuthorityKey | null | undefined;
  readonly public: AuthorityPublicParts[K];
  readonly private?: AuthorityPrivateParts[K] | null | undefined;
} }[AuthorityKind];

export interface AuthorityWriteContext {
  readonly origin: string;
  readonly now: number;
}

/** Issue (or replace) entries at the next revision. Issuing over a revoked key is refused: ids are never reused. */
export function issueEntries(record: AuthorityRecord, drafts: readonly AuthorityDraft[], context: AuthorityWriteContext): { record: AuthorityRecord; keys: AuthorityKey[] } {
  const rev = record.revision + 1;
  const entries = new Map(record.entries);
  const keys: AuthorityKey[] = [];
  for (const draft of drafts) {
    const key = keyOf(draft);
    const existing = entries.get(key);
    if (existing?.revoked) throw new AuthorityRevokedError(key, existing.revoked);
    const entry = {
      kind: draft.kind,
      id: draft.id,
      rev,
      authorityRev: rev,
      origin: context.origin,
      at: context.now,
      audience: draft.audience ?? existing?.audience ?? 'group',
      parent: draft.parent === undefined ? existing?.parent ?? null : draft.parent,
      revoked: null,
      public: draft.public,
      private: draft.private ?? null,
    } as AnyAuthorityEntry;
    entries.set(key, entry);
    keys.push(key);
  }
  return { record: { ...record, revision: rev, revocationFloor: Math.max(record.revocationFloor, floorFrom(entries)), entries }, keys };
}

/** Change an entry's public part. `narrowsOrWidens` moves `authorityRev`, which ends work admitted before it. */
export function updateEntry(record: AuthorityRecord, key: AuthorityKey, patch: Readonly<Record<string, unknown>>, narrowsOrWidens: boolean, context: AuthorityWriteContext, privatePart?: unknown, parent?: AuthorityKey | null): AuthorityRecord {
  const existing = record.entries.get(key);
  if (!existing) throw new AuthorityMissingError(key);
  if (existing.revoked) throw new AuthorityRevokedError(key, existing.revoked);
  const rev = record.revision + 1;
  const entries = new Map(record.entries);
  entries.set(key, {
    ...existing,
    rev,
    authorityRev: narrowsOrWidens ? rev : existing.authorityRev,
    origin: context.origin,
    at: context.now,
    public: { ...existing.public, ...patch },
    ...(privatePart !== undefined ? { private: privatePart } : {}),
    // Moving an entry to another parent (a device paired again keeps what its old pairing minted).
    ...(parent !== undefined ? { parent } : {}),
  } as AnyAuthorityEntry);
  return { ...record, revision: rev, entries };
}

/** Revoke an entry. Terminal; revoking twice keeps the first revocation. */
export function revokeEntry(record: AuthorityRecord, key: AuthorityKey, by: string, reason: string, context: AuthorityWriteContext): AuthorityRecord {
  const existing = record.entries.get(key);
  if (!existing) throw new AuthorityMissingError(key);
  if (existing.revoked) return record;
  const rev = record.revision + 1;
  const entries = new Map(record.entries);
  entries.set(key, { ...existing, revoked: { rev, origin: context.origin, at: context.now, by, reason: reason.slice(0, 200) } } as AnyAuthorityEntry);
  return { ...record, revision: rev, entries };
}

/** Drop revoked entries older than `maxAgeMs` whose revocation every member has (`coveredThrough`). */
export function compactAuthority(record: AuthorityRecord, now: number, maxAgeMs: number, coveredThrough: number | null): AuthorityRecord {
  if (coveredThrough === null) return record;
  let changed = false;
  const entries = new Map(record.entries);
  const compacted: Record<string, number> = { ...record.compacted };
  for (const [key, entry] of record.entries) {
    const revocation = entry.revoked;
    if (!revocation || revocation.rev > coveredThrough || now - revocation.at < maxAgeMs) continue;
    entries.delete(key);
    compacted[entry.origin] = Math.max(compacted[entry.origin] ?? 0, entry.rev);
    changed = true;
  }
  return changed ? { ...record, entries, compacted } : record;
}

export class AuthorityRevokedError extends Error {
  override readonly name = 'AuthorityRevokedError';
  constructor(readonly key: AuthorityKey, readonly revocation: AuthorityRevocation) {
    super(`${key} was revoked at revision ${revocation.rev} by ${revocation.by || 'an operator'} on node ${revocation.origin}`);
  }
}

export class AuthorityMissingError extends Error {
  override readonly name = 'AuthorityMissingError';
  constructor(readonly key: AuthorityKey) { super(`${key} is not in the authority record`); }
}

// ── digest ──────────────────────────────────────────────────────────────────

function sortedObject<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The content digest two copies compare. Covers every entry (private parts by
 * their hash only), the floor and the compaction marks; not the scope (a node
 * and the group it just joined compare equal once their entries match) and not
 * `at` stamps (display only).
 */
export function authorityDigest(record: AuthorityRecord): string {
  const hash = createHash('sha256');
  hash.update(`floor:${record.revocationFloor}\0compacted:${canonical(sortedObject(record.compacted))}\0`);
  for (const [key, entry] of [...record.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const privateHash = entry.private === null ? '' : createHash('sha256').update(canonical(entry.private)).digest('hex');
    hash.update(canonical({
      key, rev: entry.rev, authorityRev: entry.authorityRev, origin: entry.origin, audience: entry.audience,
      parent: entry.parent, revoked: entry.revoked ? { rev: entry.revoked.rev, origin: entry.revoked.origin } : null,
      public: entry.public, privateHash,
    }));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}

export function authorityHead(record: AuthorityRecord): AuthorityHead {
  return { revision: record.revision, digest: authorityDigest(record) };
}

// ── views ───────────────────────────────────────────────────────────────────

export interface AuthorityView {
  readonly record: AuthorityRecord;
  readonly head: AuthorityHead;
  /** The node this view answers for. */
  readonly nodeId: string;
  entry<K extends AuthorityKind>(kind: K, id: string): AuthorityEntry<K> | null;
  /** Revoked itself or through an ancestor. */
  isRevoked(key: AuthorityKey): boolean;
  /** Live, no revoked ancestor, audience includes this node, authorityRev unchanged since capture. */
  isCurrent(ref: AuthorityRef): boolean;
  /** Every entry of a kind, revoked ones included. */
  list<K extends AuthorityKind>(kind: K): readonly AuthorityEntry<K>[];
  deviceTokenByHash(tokenHash: string): AuthorityEntry<'device-token'> | null;
  /** True when a device token with this hash is on the record and revoked (itself or through a parent). */
  deviceTokenRevoked(tokenHash: string): boolean;
  peerTokenByHash(tokenHash: string): AuthorityEntry<'peer-token'> | null;
  relayRouteByHash(routeHash: string): AuthorityEntry<'relay-route'> | null;
  /** The live incarnation of a user, or null. */
  user(username: string): AuthorityEntry<'user'> | null;
  /**
   * Usernames with more than one live incarnation: separate accounts of one
   * name, made on machines that later joined one group (owner decision D2).
   * Reported, never merged silently; each machine keeps its own account.
   */
  userConflicts(): readonly AuthorityUserConflict[];
  deviceGrant(query: { readonly nodeId: string; readonly capabilityId: string; readonly sessionId?: string | undefined }): AuthorityEntry<'device-grant'> | null;
  pushEndpoints(principalId?: string): readonly AuthorityEntry<'push-endpoint'>[];
  /** Live member entries, one per node (rule 4). */
  members(): readonly AuthorityEntry<'member'>[];
  isCurrentMember(nodeId: string): boolean;
  /** Keys whose `parent` chain reaches `key`. */
  descendants(key: AuthorityKey): readonly AuthorityKey[];
}

/** One username held by separate accounts, each made on its own machine. */
export interface AuthorityUserConflict {
  readonly username: string;
  readonly incarnations: readonly { readonly id: string; readonly origin: string; readonly createdAt: number }[];
}

/** Build the read view once per change; every per-request question is then a map read. */
/**
 * What this machine dropped from its record (compaction past the retention, or
 * a return after longer than it) and must keep treating as revoked: a store's
 * own copy of the credential, and anything whose parent it was, never reads
 * as live again. Kept by the record file, local to this machine.
 */
export interface AuthorityForgotten {
  readonly keys: ReadonlySet<AuthorityKey>;
  /** Token, route and endpoint hashes of those entries. */
  readonly hashes: ReadonlySet<string>;
}

export function buildAuthorityView(record: AuthorityRecord, nodeId: string, forgotten?: AuthorityForgotten): AuthorityView {
  const head = authorityHead(record);
  const byKind = new Map<AuthorityKind, AnyAuthorityEntry[]>();
  const children = new Map<AuthorityKey, AuthorityKey[]>();
  const deviceTokens = new Map<string, AuthorityEntry<'device-token'>>();
  const peerTokens = new Map<string, AuthorityEntry<'peer-token'>>();
  const relayRoutes = new Map<string, AuthorityEntry<'relay-route'>>();
  const users = new Map<string, AuthorityEntry<'user'>>();
  const userIncarnations = new Map<string, AuthorityEntry<'user'>[]>();
  for (const [key, entry] of record.entries) {
    const list = byKind.get(entry.kind) ?? [];
    list.push(entry);
    byKind.set(entry.kind, list);
    if (entry.parent) children.set(entry.parent, [...(children.get(entry.parent) ?? []), key]);
  }
  const revokedMemo = new Map<AuthorityKey, boolean>();
  const isRevoked = (key: AuthorityKey, seen = new Set<AuthorityKey>()): boolean => {
    const memo = revokedMemo.get(key);
    if (memo !== undefined) return memo;
    const entry = record.entries.get(key);
    // An unknown parent is not proof of anything: only a revocation revokes.
    let revoked = !!entry?.revoked || (forgotten?.keys.has(key) ?? false);
    if (!revoked && entry?.parent && !seen.has(key)) {
      seen.add(key);
      revoked = isRevoked(entry.parent, seen);
    }
    revokedMemo.set(key, revoked);
    return revoked;
  };
  const audienceIncludes = (entry: AnyAuthorityEntry): boolean => entry.audience === 'group' || entry.audience.nodeId === nodeId;
  const live = (entry: AnyAuthorityEntry): boolean => !isRevoked(keyOf(entry)) && audienceIncludes(entry);
  const revokedDeviceTokens = new Set<string>();
  for (const entry of byKind.get('device-token') ?? []) {
    if (entry.kind !== 'device-token') continue;
    if (live(entry)) deviceTokens.set(entry.public.tokenHash, entry);
    else if (isRevoked(keyOf(entry))) revokedDeviceTokens.add(entry.public.tokenHash);
  }
  for (const entry of byKind.get('peer-token') ?? []) if (entry.kind === 'peer-token' && live(entry)) peerTokens.set(entry.public.tokenHash, entry);
  for (const entry of byKind.get('relay-route') ?? []) if (entry.kind === 'relay-route' && live(entry)) relayRoutes.set(entry.public.routeHash, entry);
  for (const entry of byKind.get('user') ?? []) {
    if (entry.kind !== 'user' || !live(entry)) continue;
    const name = entry.public.username.toLowerCase();
    userIncarnations.set(name, [...(userIncarnations.get(name) ?? []), entry]);
    const existing = users.get(name);
    // Two live incarnations (two nodes created the same name apart): the
    // later write is the account; owner decision D2 reports the difference.
    if (!existing || laterWrite(entry, existing) > 0) users.set(name, entry);
  }
  // Rule 4: a node's member is its live incarnation above every revoked one.
  const memberEntries = (byKind.get('member') ?? []) as AuthorityEntry<'member'>[];
  const revokedGen = new Map<string, number>();
  for (const entry of memberEntries) if (entry.revoked) revokedGen.set(entry.public.nodeId, Math.max(revokedGen.get(entry.public.nodeId) ?? -1, entry.public.gen));
  const liveMembers = new Map<string, AuthorityEntry<'member'>>();
  for (const entry of memberEntries) {
    if (entry.revoked || entry.public.gen <= (revokedGen.get(entry.public.nodeId) ?? -1)) continue;
    const existing = liveMembers.get(entry.public.nodeId);
    if (!existing || entry.public.gen > existing.public.gen) liveMembers.set(entry.public.nodeId, entry);
  }
  const listOf = <K extends AuthorityKind>(kind: K): readonly AuthorityEntry<K>[] => (byKind.get(kind) ?? []) as unknown as AuthorityEntry<K>[];
  return {
    record,
    head,
    nodeId,
    entry: <K extends AuthorityKind>(kind: K, id: string) => (record.entries.get(authorityKey(kind, id)) ?? null) as AuthorityEntry<K> | null,
    isRevoked: (key) => isRevoked(key),
    isCurrent: (ref) => {
      const entry = record.entries.get(ref.key);
      return !!entry && live(entry) && entry.authorityRev === ref.authorityRev;
    },
    list: listOf,
    deviceTokenByHash: (hash) => deviceTokens.get(hash) ?? null,
    deviceTokenRevoked: (hash) => revokedDeviceTokens.has(hash) || (forgotten?.hashes.has(hash) ?? false),
    peerTokenByHash: (hash) => peerTokens.get(hash) ?? null,
    relayRouteByHash: (hash) => relayRoutes.get(hash) ?? null,
    user: (username) => users.get(username.toLowerCase()) ?? null,
    userConflicts: () => [...userIncarnations.values()]
      .filter((incarnations) => incarnations.length > 1)
      .map((incarnations) => ({
        username: incarnations[0]!.public.username,
        incarnations: incarnations.map((entry) => ({ id: entry.id, origin: entry.origin, createdAt: entry.public.createdAt }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }))
      .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)),
    deviceGrant: (query) => listOf('device-grant').find((entry) => live(entry)
      && entry.public.nodeId === query.nodeId && entry.public.capabilityId === query.capabilityId
      && (entry.public.scope === 'always' || entry.public.sessionId === (query.sessionId ?? null))) ?? null,
    pushEndpoints: (principalId) => listOf('push-endpoint').filter((entry) => live(entry) && (principalId === undefined || entry.public.principalId === principalId)),
    members: () => [...liveMembers.values()],
    isCurrentMember: (id) => liveMembers.has(id),
    descendants: (key) => {
      const out: AuthorityKey[] = [];
      const queue = [...(children.get(key) ?? [])];
      const seen = new Set<AuthorityKey>();
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        out.push(next);
        queue.push(...(children.get(next) ?? []));
      }
      return out;
    },
  };
}

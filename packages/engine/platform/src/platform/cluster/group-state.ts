/**
 * group-state.ts, who is in the group, read from the authority record.
 *
 * Membership is not a document of its own. Every admission is a `member`
 * entry of the authority record (authority-record.ts) and every removal is
 * the REVOCATION of that entry, so the roster converges by the record's merge:
 * a removal is a positive, terminal fact that no copy which has not heard of
 * it can undo, and a machine put back on purpose is a new incarnation at a
 * higher membership generation. The record is carried to every member by
 * authority-sync.ts, signed with identity keys that never rotate, so a machine
 * any number of key generations behind still learns who is in.
 *
 * What this module holds is the READ: the roster (`GroupStateDocument`) a
 * group's entries describe, and the ids those entries are written under. It is
 * PUBLIC to the group: public keys and display names, nothing secret.
 *
 * Every entry id starts with the group id, so a machine that was in another
 * group before keeps that group's entries (they are merged, never deleted)
 * without them ever counting in this one.
 */
import { type AnyAuthorityEntry, type AuthorityEntry, type AuthorityKey, type AuthorityRecord } from './authority-record.js';
import { signWithIdentity, verifyWithIdentity, type NodeKeyPairMaterial } from './group-crypto.js';
import type { KeyEpochFacts } from './group-store.js';

/** One machine in the group. */
export interface GroupMember {
  readonly nodeId: string;
  /** Operator-facing label for this machine. Never a hostname unless typed as one. */
  readonly displayName: string;
  /** ed25519 public key, how this node proves it is itself, forever. */
  readonly identityKey: string;
  /** x25519 public key, where a new group key is sealed to. */
  readonly agreementKey: string;
  readonly admittedAt: number;
  /** Membership generation (incarnation) of this node id: every admission is a higher one. */
  readonly gen: number;
}

/**
 * A removal: the revoked incarnation of a node with no live one above it.
 * Not the absence of a member, the PRESENCE of a refusal.
 */
export interface GroupTombstone {
  readonly nodeId: string;
  readonly gen: number;
  readonly at: number;
  /** Short plain-language reason, shown in `cluster nodes`. Never a hostname. */
  readonly reason: string;
  /** The removed machine's identity key: it can still be told, verifiably, that it was removed. */
  readonly identityKey: string;
  /**
   * Fingerprint of the join key the group used when the machine was removed,
   * which the removed machine still holds. A join proved with that key never
   * puts it back (see `decideAdmission`).
   */
  readonly removedUnder?: string;
}

/** The roster one group's record entries describe. */
export interface GroupStateDocument {
  readonly version: 1;
  readonly groupId: string;
  /** The name shown in the discovery beacon, visible to anything on this network. */
  readonly displayName: string;
  readonly members: readonly GroupMember[];
  readonly tombstones: readonly GroupTombstone[];
  /** The group signing public key of the newest generation on the record, and its generation. */
  readonly groupSigning: GroupSigningPublicKey;
}

/** The group's signing public key at one generation. */
export interface GroupSigningPublicKey {
  readonly publicKey: string;
  readonly generation: number;
}

/** The neutral name a group gets when the operator does not choose one. */
export const DEFAULT_GROUP_DISPLAY_NAME = 'goodvibes group';

/** 64 members is far past any homelab and still a small record to carry. */
export const MAX_GROUP_MEMBERS = 64;
/** Longest a display name may be. Long enough to be descriptive, short enough to fit a beacon. */
export const MAX_GROUP_DISPLAY_NAME_LENGTH = 48;

/** Trim and cap a display name; empty input falls back to the neutral default. */
export function normalizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return fallback;
  return collapsed.slice(0, MAX_GROUP_DISPLAY_NAME_LENGTH);
}

// ── entry ids ───────────────────────────────────────────────────────────────

/** The record id of one incarnation of a member. */
export function memberEntryId(groupId: string, nodeId: string, gen: number): string {
  return `${groupId}#${nodeId}#${gen}`;
}

/** The record id of one key generation. */
export function keyEpochEntryId(groupId: string, epoch: number): string {
  return `${groupId}#${epoch}`;
}

/** True when a record entry belongs to `groupId`'s membership, keys or name. */
export function isGroupEntry(entry: AnyAuthorityEntry, groupId: string): boolean {
  if (entry.kind === 'group') return entry.id === groupId;
  return (entry.kind === 'member' || entry.kind === 'key-epoch') && entry.id.startsWith(`${groupId}#`);
}

// ── reading ─────────────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A member entry's public part, validated: it may have arrived from another machine. */
function readMemberEntry(entry: AuthorityEntry<'member'>): GroupMember | null {
  const value = entry.public as unknown as Record<string, unknown>;
  if (!isNonEmptyString(value['nodeId'], 128) || !nonNegativeInteger(value['gen'])) return null;
  if (!isNonEmptyString(value['identityKey'], 128) || !isNonEmptyString(value['agreementKey'], 128)) return null;
  return {
    nodeId: value['nodeId'],
    displayName: normalizeDisplayName(value['displayName'], value['nodeId'].slice(0, 8)),
    identityKey: value['identityKey'],
    agreementKey: value['agreementKey'],
    admittedAt: typeof value['admittedAt'] === 'number' && Number.isFinite(value['admittedAt']) ? Math.trunc(value['admittedAt']) : 0,
    gen: value['gen'],
  };
}

/** A key-epoch entry's public part, validated. */
export function readKeyEpochEntry(entry: AuthorityEntry<'key-epoch'>): KeyEpochFacts | null {
  const value = entry.public as unknown as Record<string, unknown>;
  const signing = value['signing'] as Record<string, unknown> | null | undefined;
  if (!nonNegativeInteger(value['epoch']) || (value['cause'] !== 'scheduled' && value['cause'] !== 'revocation')) return null;
  if (typeof value['mintedBy'] !== 'string' || !isNonEmptyString(value['keyCommitment'], 128) || typeof value['joinVerifier'] !== 'string') return null;
  if (!signing || typeof signing !== 'object' || !isNonEmptyString(signing['publicKey'], 128) || !nonNegativeInteger(signing['generation'])) return null;
  return {
    epoch: value['epoch'],
    cause: value['cause'],
    mintedBy: value['mintedBy'],
    createdAt: typeof value['createdAt'] === 'number' && Number.isFinite(value['createdAt']) ? Math.trunc(value['createdAt']) : 0,
    keyCommitment: value['keyCommitment'],
    signing: { publicKey: signing['publicKey'], generation: signing['generation'] },
    joinVerifier: value['joinVerifier'],
  };
}

/** Every key generation the record holds for `groupId`, by generation. */
export function keyEpochsFromRecord(record: AuthorityRecord, groupId: string): Map<number, KeyEpochFacts> {
  const epochs = new Map<number, KeyEpochFacts>();
  for (const entry of record.entries.values()) {
    if (entry.kind !== 'key-epoch' || !isGroupEntry(entry, groupId)) continue;
    const facts = readKeyEpochEntry(entry);
    if (facts && entry.id === keyEpochEntryId(groupId, facts.epoch)) epochs.set(facts.epoch, facts);
  }
  return epochs;
}

/**
 * The roster `groupId`'s entries describe. Per node: its live incarnation
 * above every revoked one is the member; a revoked incarnation with no live
 * one above it is the removal. At equal generation revoked wins (the merge
 * keeps a revocation terminal), which is the partition rule: a node that did
 * not hear of a removal can never bring the machine back.
 */
export function groupStateFromRecord(record: AuthorityRecord, groupId: string): GroupStateDocument {
  const live = new Map<string, GroupMember>();
  const removed = new Map<string, GroupTombstone>();
  let displayName = DEFAULT_GROUP_DISPLAY_NAME;
  let signing: GroupSigningPublicKey = { publicKey: '', generation: -1 };
  let signingEpoch = -1;
  for (const entry of record.entries.values()) {
    if (!isGroupEntry(entry, groupId)) continue;
    if (entry.kind === 'group') {
      displayName = normalizeDisplayName(entry.public.displayName, DEFAULT_GROUP_DISPLAY_NAME);
      continue;
    }
    if (entry.kind === 'key-epoch') {
      const facts = readKeyEpochEntry(entry);
      if (facts && facts.epoch > signingEpoch) { signingEpoch = facts.epoch; signing = facts.signing; }
      continue;
    }
    if (entry.kind !== 'member') continue;
    const member = readMemberEntry(entry);
    if (!member || entry.id !== memberEntryId(groupId, member.nodeId, member.gen)) continue;
    if (entry.revoked) {
      const existing = removed.get(member.nodeId);
      if (!existing || member.gen > existing.gen) {
        const removedUnder = (entry.public as { readonly removedUnder?: unknown }).removedUnder;
        removed.set(member.nodeId, {
          nodeId: member.nodeId,
          gen: member.gen,
          at: entry.revoked.at,
          reason: normalizeDisplayName(entry.revoked.reason, 'removed'),
          identityKey: member.identityKey,
          ...(typeof removedUnder === 'string' && /^[a-f0-9]{32}$/.test(removedUnder) ? { removedUnder } : {}),
        });
      }
      continue;
    }
    const existing = live.get(member.nodeId);
    if (!existing || member.gen > existing.gen) live.set(member.nodeId, member);
  }
  for (const [nodeId, tombstone] of removed) {
    const member = live.get(nodeId);
    if (!member) continue;
    // A removal at or above the live incarnation removes it; one below it is
    // history (the machine was put back after it).
    if (tombstone.gen >= member.gen) live.delete(nodeId);
    else removed.delete(nodeId);
  }
  const byNodeId = <T extends { readonly nodeId: string }>(a: T, b: T): number => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
  return {
    version: 1,
    groupId,
    displayName,
    members: [...live.values()].sort(byNodeId),
    tombstones: [...removed.values()].sort(byNodeId),
    groupSigning: signing,
  };
}

/** The next membership generation to write for `nodeId`, above every incarnation held. */
export function nextMembershipGeneration(state: GroupStateDocument, nodeId: string): number {
  const member = state.members.find((entry) => entry.nodeId === nodeId);
  const tombstone = state.tombstones.find((entry) => entry.nodeId === nodeId);
  return Math.max(member?.gen ?? 0, tombstone?.gen ?? 0) + 1;
}

/** True when `nodeId` is currently a member. */
export function isCurrentMember(state: GroupStateDocument, nodeId: string): boolean {
  return state.members.some((entry) => entry.nodeId === nodeId);
}

/** The removal that still applies to `nodeId`, if the group recorded one. */
export function findTombstone(state: GroupStateDocument, nodeId: string): GroupTombstone | null {
  return state.tombstones.find((entry) => entry.nodeId === nodeId) ?? null;
}

// ── rule 7: whose entries a member takes ────────────────────────────────────

/**
 * What a member's identity key signs to bind its daemon home's record id (the
 * `origin` of every entry that home writes) to its membership. With it, an
 * entry's origin names a member of the group, checked against the member's
 * identity key, never against anything the entry says about itself.
 */
function originBindingMessage(groupId: string, nodeId: string, origin: string): string {
  return `goodvibes-cluster-authority-origin-v1\0${groupId}\0${nodeId}\0${origin}`;
}

/** Sign this machine's record id into its membership of `groupId`. */
export function signOriginBinding(identity: NodeKeyPairMaterial, groupId: string, nodeId: string, origin: string): string {
  return signWithIdentity(identity, originBindingMessage(groupId, nodeId, origin));
}

/** True when `proof` binds `origin` to `nodeId` under `identityKey`. */
export function originBindingHolds(identityKey: string, groupId: string, nodeId: string, origin: string, proof: string): boolean {
  try { return verifyWithIdentity(identityKey, originBindingMessage(groupId, nodeId, origin), proof); }
  catch { return false; }
}

const bindingChecks = new Map<string, boolean>();

/**
 * Rule 7 for `groupId`, per entry (the `admit` merge option of
 * authority-record.ts). Each member entry with a valid binding names the
 * record id its daemon home writes under:
 *
 *  - an origin bound to a live member: its entries are taken;
 *  - an origin bound only to removed members: its entries and revocations up
 *    to the revision recorded with the removal (`originCutoff`, the newest of
 *    its writes the removing member held) stand, anything above it was written
 *    after the removal and is refused, on every member, however it arrives;
 *  - an origin no member is bound to (entries a machine brought with it from
 *    before it joined, owner decision D2): taken, as before.
 *
 * A function of the merged entries alone, so every member reaches the same
 * answer whatever order changes arrive in. Null when no member of the group
 * carries a binding.
 */
export function originAdmission(groupId: string): (entries: ReadonlyMap<AuthorityKey, AnyAuthorityEntry>) => ((entry: AnyAuthorityEntry) => AnyAuthorityEntry | null) | null {
  return (entries) => {
    const limits = new Map<string, number>();
    for (const entry of entries.values()) {
      if (entry.kind !== 'member' || !isGroupEntry(entry, groupId)) continue;
      const value = entry.public as unknown as Record<string, unknown>;
      const origin = value['authorityOrigin'], proof = value['originProof'], nodeId = value['nodeId'], identityKey = value['identityKey'];
      if (typeof origin !== 'string' || typeof proof !== 'string' || typeof nodeId !== 'string' || typeof identityKey !== 'string') continue;
      const cacheKey = `${identityKey}\0${groupId}\0${nodeId}\0${origin}\0${proof}`;
      let holds = bindingChecks.get(cacheKey);
      if (holds === undefined) {
        holds = originBindingHolds(identityKey, groupId, nodeId, origin, proof);
        if (bindingChecks.size > 4_096) bindingChecks.clear();
        bindingChecks.set(cacheKey, holds);
      }
      if (!holds) continue;
      const cutoff = value['originCutoff'];
      const limit = entry.revoked === null ? Number.POSITIVE_INFINITY
        : typeof cutoff === 'number' && Number.isSafeInteger(cutoff) ? cutoff : entry.revoked.rev - 1;
      limits.set(origin, Math.max(limits.get(origin) ?? Number.NEGATIVE_INFINITY, limit));
    }
    if (limits.size === 0) return null;
    return (entry) => {
      const limit = limits.get(entry.origin);
      if (limit !== undefined && entry.rev > limit) return null;
      const revocation = entry.revoked;
      if (revocation) {
        const revocationLimit = limits.get(revocation.origin);
        if (revocationLimit !== undefined && revocation.rev > revocationLimit) return { ...entry, revoked: null } as AnyAuthorityEntry;
      }
      return entry;
    };
  };
}

/**
 * group-store.ts, where the group's secrets live, and how the generations a
 * machine accepts are worked out from them and the authority record.
 *
 * Two homes, deliberately different, because they hold different things:
 *
 *   KEY MATERIAL, the join key, the group key of each generation, this node's
 *   private keys and the group's signing private key, goes in the ENCRYPTED
 *   secrets store and nowhere else. Not in config, not in a log line, not in
 *   /status, not in a datagram in clear. The only way any of it reaches a human
 *   is `cluster key`, which prints the join key and nothing else, on request.
 *
 *   THE PUBLIC FACTS, who the members are and every key generation (its cause,
 *   its minter, a commitment to its key, the signing public key and the join
 *   verifier in force from it), are entries of the authority record
 *   (authority-record.ts), carried to every member by authority-sync.ts.
 *
 * Which generation is current, and whether the previous one is still
 * accepted, is not stored anywhere: it is computed from those two
 * (`computeKeyAcceptance`), so no machine holds a copy of the answer that can
 * disagree with the group's record.
 */
import { revealOrNull, type Secret } from '../security/secret.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateGroupKey,
  generateGroupSigningKeyPair,
  generateNodeKeyMaterial,
  isValidPublicKey,
  type NodeKeyMaterial,
} from './group-crypto.js';
import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
import type { AuthorityPublicParts } from './authority-record.js';
import type { ClusterKeyring } from './protocol-envelope.js';
import type { ClusterLogger } from './types.js';

/** The replicated settings file, in the cluster state directory. Public to the group. */
export const GROUP_REPLICA_FILENAME = 'group-config.json';
/** Shared-setting changes made here and held until this machine holds the group's settings. */
export const GROUP_HELD_CONFIG_FILENAME = 'group-config-held.json';
/**
 * Set when another member told this machine, in a way it could verify, that the
 * group removed it. Kept so `cluster status` still says so after a restart;
 * cleared when this machine joins a group again.
 */
export const GROUP_REMOVAL_FILENAME = 'group-removed.json';
/**
 * The single secrets-store key holding every piece of group key material.
 *
 * DERIVED from the daemon-owned config path rather than written out, because
 * the name is what decides where the value lives. `defaultScopeForKey` files a
 * secret in the daemon tier exactly when its name is one the daemon's
 * derivation produces; a hand-written `'cluster.groupMaterial'` matches
 * nothing it produces, so the group's key material was landing at PROJECT
 * scope, in whichever directory the daemon happened to start in, outside the
 * tier holding every other cluster secret.
 *
 * Deriving it means the name the daemon recognises and the name actually
 * written are the same by construction, and cannot drift apart again.
 */
export const GROUP_MATERIAL_SECRET_KEY = daemonSecretKeyFor('cluster.groupMaterial');

/**
 * Bounds on key history.
 *
 * 16 generations at the default 24-hour rotation is a fortnight of history, and
 * 30 days caps it for a node that rotates faster. Neither bound costs anything
 * a returning machine needs: a member that has been off for a year rejoins by
 * proving its long-lived IDENTITY key, which never rotates and never expires,
 * old group keys are a convenience path, not the mechanism. See
 * group-membership.ts.
 */
export const MAX_KEY_GENERATIONS = 16;
export const MAX_KEY_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

/** One generation of the group key, as this machine holds it. */
export interface GroupKeyRecord {
  readonly generation: number;
  readonly key: string;
  readonly createdAt: number;
  /** The node that minted this generation (the record's key-epoch entry says the same). */
  readonly mintedBy: string;
  /**
   * When THIS machine took the key. Local, never compared across machines: the
   * previous generation stays accepted for the grace window after it.
   */
  readonly adoptedAt: number;
}

/**
 * Everything secret about this node's membership of one group. No public fact
 * lives here: which generation is current is computed (`computeKeyAcceptance`).
 */
export interface GroupKeyMaterial {
  readonly version: 1;
  readonly groupId: string;
  readonly joinKey: string;
  readonly joinSalt: string;
  /** The verifier of `joinKey`, kept with it so a JOIN is checked without a slow derivation. */
  readonly joinVerifier: string;
  readonly keys: readonly GroupKeyRecord[];
  readonly node: NodeKeyMaterial;
  /**
   * The GROUP's signing key pair, and which generation of it this is.
   *
   * Every member holds the private half, so any member can answer a returning
   * machine as the group rather than as itself. It is replaced by a
   * REVOCATION (a removal, or `rotate --now`), whose new private half reaches
   * every remaining member sealed with that generation's key; a scheduled
   * rotation leaves it alone, because its job is to be verifiable by a machine
   * holding a public key from months ago.
   */
  readonly groupSigning: GroupSigningMaterial;
}

/** A key generation's public facts, as the authority record holds them. */
export type KeyEpochFacts = AuthorityPublicParts['key-epoch'];

/**
 * A public commitment to one generation's key: who holds the same key can be
 * checked against the record without the key ever being written there.
 */
export function keyCommitment(groupId: string, epoch: number, key: string): string {
  return createHash('sha256').update(`goodvibes-cluster-key-epoch-v1\0${groupId}\0${epoch}\0${key}`).digest('hex');
}

/** Which generations this machine signs with and accepts, computed, never stored. */
export interface KeyAcceptance {
  /** The generation this machine signs with. */
  readonly current: number;
  /** The generation before it while it is still accepted, else null. */
  readonly previous: number | null;
  /** Wall-clock ms until which `previous` is accepted. */
  readonly previousUntil: number;
  /** The highest generation minted by a revocation, or -1: the generation below it is never reopened. */
  readonly floor: number;
}

/**
 * The generations this machine accepts, from the record's key epochs and the
 * keys it holds. Nothing else decides it.
 *
 *  - current: the highest generation on the record whose key this machine
 *    holds with a matching commitment. A machine that holds a key the record
 *    does not know (the record was lost) signs with its newest key until it
 *    catches up.
 *  - previous (current - 1): accepted only while the current generation is
 *    above every generation a revocation minted (a removal or `rotate --now`
 *    opens no window, on any machine, and a machine that joins later learns
 *    the same floor from the record), and only for the grace window after this
 *    machine took the current key.
 */
export function computeKeyAcceptance(
  material: GroupKeyMaterial,
  epochs: ReadonlyMap<number, KeyEpochFacts>,
  graceMs: number,
): KeyAcceptance {
  let floor = -1;
  for (const epoch of epochs.values()) if (epoch.cause === 'revocation') floor = Math.max(floor, epoch.epoch);
  const matches = (record: GroupKeyRecord): boolean => {
    const facts = epochs.get(record.generation);
    return facts !== undefined && facts.keyCommitment === keyCommitment(material.groupId, record.generation, record.key);
  };
  const newestFirst = [...material.keys].sort((a, b) => b.generation - a.generation);
  const current = newestFirst.find(matches) ?? newestFirst[0]!;
  const before = newestFirst.find((record) => record.generation === current.generation - 1);
  const previous = current.generation > floor && before && (epochs.size === 0 || matches(before)) ? before.generation : null;
  return { current: current.generation, previous, previousUntil: previous === null ? 0 : current.adoptedAt + graceMs, floor };
}

/** The group's signing key pair at one generation. */
export interface GroupSigningMaterial {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly generation: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate one key record. Exported so the wire path reuses exactly this check. */
export function readKeyRecord(value: unknown): GroupKeyRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isFiniteNumber(candidate['generation']) || candidate['generation'] < 0) return null;
  if (typeof candidate['key'] !== 'string' || candidate['key'].length === 0) return null;
  if (!isFiniteNumber(candidate['createdAt'])) return null;
  return {
    generation: Math.trunc(candidate['generation']),
    key: candidate['key'],
    createdAt: Math.trunc(candidate['createdAt']),
    mintedBy: typeof candidate['mintedBy'] === 'string' ? candidate['mintedBy'] : '',
    adoptedAt: isFiniteNumber(candidate['adoptedAt']) ? Math.trunc(candidate['adoptedAt']) : Math.trunc(candidate['createdAt']),
  };
}

/** Validate a stored group signing key pair. */
export function readGroupSigningMaterial(value: unknown): GroupSigningMaterial | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isValidPublicKey(candidate['publicKey'])) return null;
  if (typeof candidate['privateKey'] !== 'string' || candidate['privateKey'].length === 0) return null;
  if (!isFiniteNumber(candidate['generation']) || candidate['generation'] < 0) return null;
  return {
    publicKey: candidate['publicKey'],
    privateKey: candidate['privateKey'],
    generation: Math.trunc(candidate['generation']),
  };
}

function readNodeKeyMaterial(value: unknown): NodeKeyMaterial | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const identity = candidate['identity'] as Record<string, unknown> | undefined;
  const agreement = candidate['agreement'] as Record<string, unknown> | undefined;
  if (!identity || !agreement) return null;
  if (!isValidPublicKey(identity['publicKey']) || typeof identity['privateKey'] !== 'string') return null;
  if (!isValidPublicKey(agreement['publicKey']) || typeof agreement['privateKey'] !== 'string') return null;
  return {
    identity: { publicKey: identity['publicKey'], privateKey: identity['privateKey'] },
    agreement: { publicKey: agreement['publicKey'], privateKey: agreement['privateKey'] },
  };
}

/**
 * Parse stored key material.
 *
 * Returns null rather than a partly-filled object on anything unexpected. A
 * half-valid key blob is not something to work around: the node has no usable
 * membership, and saying so plainly (`cluster status` reports it, and the fix
 * is to join again) beats limping along signing with a key nobody accepts.
 */
export function readGroupKeyMaterial(value: unknown): GroupKeyMaterial | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== 1) return null;
  if (typeof candidate['groupId'] !== 'string' || candidate['groupId'].length === 0) return null;
  if (typeof candidate['joinKey'] !== 'string' || candidate['joinKey'].length === 0) return null;
  if (typeof candidate['joinSalt'] !== 'string' || typeof candidate['joinVerifier'] !== 'string') return null;
  const node = readNodeKeyMaterial(candidate['node']);
  if (!node) return null;
  const groupSigning = readGroupSigningMaterial(candidate['groupSigning']);
  if (!groupSigning) return null;
  const keys = (Array.isArray(candidate['keys']) ? candidate['keys'] : [])
    .map(readKeyRecord)
    .filter((entry): entry is GroupKeyRecord => entry !== null)
    .sort((a, b) => b.generation - a.generation);
  if (keys.length === 0) return null;
  return {
    version: 1,
    groupId: candidate['groupId'],
    joinKey: candidate['joinKey'],
    joinSalt: candidate['joinSalt'],
    joinVerifier: candidate['joinVerifier'],
    keys,
    node,
    groupSigning,
  };
}

export interface KeyHistorySweepResult {
  readonly keys: readonly GroupKeyRecord[];
  readonly dropped: number;
}

/**
 * Bound the key history.
 *
 * The current generation and the one before it are ALWAYS kept regardless of
 * age, dropping either would break the acceptance window and cause exactly the
 * spurious elections the window exists to prevent.
 */
export function sweepKeyHistory(
  keys: readonly GroupKeyRecord[],
  currentGeneration: number,
  now: number,
): KeyHistorySweepResult {
  const pinned = new Set([currentGeneration, currentGeneration - 1]);
  const cutoff = now - MAX_KEY_AGE_MS;
  const sorted = [...keys].sort((a, b) => b.generation - a.generation);
  const kept: GroupKeyRecord[] = [];
  for (const record of sorted) {
    if (pinned.has(record.generation)) {
      kept.push(record);
      continue;
    }
    if (kept.length >= MAX_KEY_GENERATIONS) continue;
    if (record.createdAt < cutoff) continue;
    kept.push(record);
  }
  return { keys: kept, dropped: keys.length - kept.length };
}

/**
 * The keyring the envelope codec signs and verifies with.
 *
 * Reads through to the material and the acceptance the runtime computed last
 * (on every change of either), so a generation taken from the record is used
 * by the very next datagram, and a datagram costs no file read.
 */
export class GroupKeyring implements ClusterKeyring {
  constructor(
    private readonly read: () => { readonly material: GroupKeyMaterial; readonly acceptance: KeyAcceptance },
    private readonly now: () => number,
  ) {}

  get groupId(): string {
    return this.read().material.groupId;
  }

  get currentGeneration(): number {
    return this.read().acceptance.current;
  }

  keyForGeneration(generation: number): string | null {
    return this.read().material.keys.find((entry) => entry.generation === generation)?.key ?? null;
  }

  /** The current generation, plus the previous one while `computeKeyAcceptance` keeps it open. */
  acceptedGenerations(): readonly number[] {
    const { acceptance } = this.read();
    if (acceptance.previous !== null && acceptance.previousUntil > this.now()) return [acceptance.current, acceptance.previous];
    return [acceptance.current];
  }

  /** Every generation still held, for checking an old-key proof from a returning node. */
  heldGenerations(): readonly number[] {
    return this.read().material.keys.map((entry) => entry.generation);
  }
}

// ── persistence ─────────────────────────────────────────────────────────────

/**
 * The slice of the encrypted secrets store this module needs.
 *
 * Narrow on purpose: `SecretsManager` satisfies it structurally, and a test can
 * satisfy it with a Map. Nothing here should know about secret scopes, policy
 * modes or file layout.
 */
export interface ClusterSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Successful local credential writes/deletes; values are never in events. */
  onDidChange?(listener: (key: string) => void): () => void;
  /** Who made the write whose notice is being delivered now, and how it was decided (`SecretsManager.writeAct`). */
  writeAct?(): import('./config-replica.js').ReplicaAct | undefined;
}

/** What {@link clusterSecretStoreFrom} needs of the secrets store; `SecretsManager` satisfies it. */
export interface ClusterSecretsSource {
  get(key: string): Promise<Secret | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** The daemon tier's own entry; throws when that store exists but cannot be read. */
  getWriteScopeEntry(key: string, scope: 'daemon'): Promise<Secret | null>;
  onDidChange?(listener: (key: string) => void): () => void;
  writeAct?(): import('./config-replica.js').ReplicaAct | undefined;
}

/**
 * The cluster's view of the secrets store.
 *
 * `SecretsManager.get` answers an unreadable store with "nothing stored". The
 * group must not take that for absence: a machine would leave its group, and a
 * replicated credential would be announced as deleted to every member. Every
 * key the cluster stores is daemon-owned, so an absent answer is checked
 * against the daemon tier itself, which throws when it cannot be read.
 */
export function clusterSecretStoreFrom(source: ClusterSecretsSource): ClusterSecretStore {
  const onDidChange = source.onDidChange;
  const writeAct = source.writeAct;
  return {
    ...(writeAct ? { writeAct: () => writeAct.call(source) } : {}),
    // The cluster layer reads its own material (the group key, replicated settings) as text.
    get: async (key) => {
      const value = revealOrNull(await source.get(key), 'dispatch');
      if (value === null) await source.getWriteScopeEntry(key, 'daemon');
      return value;
    },
    set: (key, value) => source.set(key, value),
    delete: (key) => source.delete(key),
    ...(onDidChange ? { onDidChange: (listener: (key: string) => void) => onDidChange.call(source, listener) } : {}),
  };
}

/** One actual store read distinguishes absence from unreadable/uncertain data. */
export interface GroupMaterialObservation {
  readonly material: GroupKeyMaterial | null;
  readonly unreadable: boolean;
}
export async function observeGroupKeyMaterial(secrets: ClusterSecretStore, logger?: ClusterLogger): Promise<GroupMaterialObservation> {
  let raw: string | null;
  try { raw = await secrets.get(GROUP_MATERIAL_SECRET_KEY); }
  catch {
    logger?.error('cluster: the encrypted group membership could not be read', { action: 'check the secrets store, then restart and look at Devices and network, Machine group' });
    return { material: null, unreadable: true };
  }
  if (raw === null) return { material: null, unreadable: false };
  let material: GroupKeyMaterial | null;
  try { material = readGroupKeyMaterial(JSON.parse(raw) as unknown); }
  catch { material = null; }
  if (!material) logger?.error('cluster: the stored group membership is not readable', { action: 'inspect the secrets store, then restart and rejoin the group' });
  return { material, unreadable: material === null };
}

/** Read membership; the observation API additionally distinguishes unreadable data. */
export async function loadGroupKeyMaterial(secrets: ClusterSecretStore, logger?: ClusterLogger): Promise<GroupKeyMaterial | null> {
  return (await observeGroupKeyMaterial(secrets, logger)).material;
}

/** Persist key material. Every write goes through here so nothing else formats it. */
export async function saveGroupKeyMaterial(
  secrets: ClusterSecretStore,
  material: GroupKeyMaterial,
): Promise<void> {
  await secrets.set(GROUP_MATERIAL_SECRET_KEY, JSON.stringify(material));
}

/** Forget this node's membership entirely. */
export async function clearGroupKeyMaterial(secrets: ClusterSecretStore): Promise<void> {
  await secrets.delete(GROUP_MATERIAL_SECRET_KEY);
}

/** Mint the key material for a brand-new group: generation 0, minted here. */
export function createGroupKeyMaterial(input: {
  readonly groupId: string;
  readonly joinKey: string;
  readonly joinSalt: string;
  readonly joinVerifier: string;
  readonly nodeId: string;
  readonly now: number;
}): GroupKeyMaterial {
  const now = Math.trunc(input.now);
  return {
    version: 1,
    groupId: input.groupId,
    joinKey: input.joinKey,
    joinSalt: input.joinSalt,
    joinVerifier: input.joinVerifier,
    keys: [{ generation: 0, key: generateGroupKey(), createdAt: now, mintedBy: input.nodeId, adoptedAt: now }],
    node: generateNodeKeyMaterial(),
    groupSigning: { ...generateGroupSigningKeyPair(), generation: 0 },
  };
}

/** Why a rotation happened, and therefore whether the old key stays acceptable. */
export type RotationCause = 'scheduled' | 'revocation';

/**
 * Take one generation's key into the material: added, or put in place of a
 * different key held for the same generation (another minter's key won that
 * generation on the record). Bounded by `sweepKeyHistory`.
 */
export function withGroupKey(material: GroupKeyMaterial, record: GroupKeyRecord, keepFrom: number, now: number): GroupKeyMaterial {
  const keys = [...material.keys.filter((entry) => entry.generation !== record.generation), record];
  return { ...material, keys: sweepKeyHistory(keys, keepFrom, now).keys };
}

// ── files beside the record ─────────────────────────────────────────────────

/**
 * Read the changes this machine held for `groupId` before it stopped: the raw
 * list for the caller's policy filter, or an empty list when there is none, it
 * belongs to another group, or it cannot be read (logged).
 */
export function loadHeldConfigChanges(stateDirectory: string, groupId: string, logger?: ClusterLogger): unknown {
  const filePath = join(stateDirectory, GROUP_HELD_CONFIG_FILENAME);
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { readonly groupId?: unknown; readonly held?: unknown } | null;
    return parsed && parsed.groupId === groupId ? parsed.held : [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      logger?.warn('cluster: the held setting changes could not be read; changes made here before the restart and not yet sent are lost', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

/**
 * Read the replicated settings document.
 *
 * Content-validated through the caller's policy filter, so a file edited by
 * hand, or written by an older build with a wider policy, cannot smuggle a
 * node-local key into this machine's config on the next start.
 */
export function loadReplicaDocument<T>(
  stateDirectory: string,
  parse: (value: unknown) => T | null,
  logger?: ClusterLogger,
): T | null {
  const filePath = join(stateDirectory, GROUP_REPLICA_FILENAME);
  try {
    const parsed = parse(JSON.parse(readFileSync(filePath, 'utf8')));
    if (parsed) return parsed;
    logger?.warn('cluster: the stored replicated settings were not readable; starting from an empty set', {
      filePath,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      logger?.warn('cluster: the replicated settings file could not be read; starting from an empty set', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

/** The record of this machine's removal from a group, as `cluster status` reports it. */
export interface GroupRemovalNote {
  readonly groupId: string;
  readonly groupName: string | null;
  readonly at: number;
  readonly reason: string;
}

/** Read the stored removal record, or null when there is none or it cannot be read. */
export function loadGroupRemovalNote(stateDirectory: string): GroupRemovalNote | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDirectory, GROUP_REMOVAL_FILENAME), 'utf8')) as Record<string, unknown> | null;
    const removed = parsed?.['removed'] as Record<string, unknown> | null | undefined;
    if (!removed || typeof removed['groupId'] !== 'string' || typeof removed['at'] !== 'number' || typeof removed['reason'] !== 'string') return null;
    return {
      groupId: removed['groupId'],
      groupName: typeof removed['groupName'] === 'string' ? removed['groupName'] : null,
      at: removed['at'],
      reason: removed['reason'],
    };
  } catch {
    return null;
  }
}

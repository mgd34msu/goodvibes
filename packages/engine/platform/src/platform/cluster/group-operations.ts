/**
 * group-operations.ts, the seven things an operator can do to a group.
 *
 * Every one of them returns STRUCTURED DATA. Nothing here formats a table,
 * pads a column or decides on a colour. That is deliberate and it is the rule
 * for the whole feature: the CLI renders human text from these results, `--json`
 * prints the same results verbatim, and the TUI and web UI render them their own
 * way. One implementation, three renderings, never a second code path that
 * drifts from the first.
 *
 * These are also exactly the daemon verbs. The CLI does not reach past them,
 * which is what makes `cluster status` against a remote daemon behave
 * identically to running it on the machine itself.
 */
import { decideUserAccount, UserAccountDecisionError } from './authority-user-decision.js';
import type { AuthorityRecordFile } from './authority-record-file.js';
import {
  generateGroupId,
  deriveJoinSalt,
  deriveJoinVerifier,
  generateJoinKey,
  normalizeJoinKey,
} from './group-crypto.js';
import type { ClusterGroupRuntime, DiscoveredGroup, SurfaceHolding } from './group-runtime.js';
import { ConfigLocalDifferenceError, type ConfigReplicationStatus } from './config-replication.js';
import type { ClusterElectionTiming } from './types.js';
import {
  DEFAULT_GROUP_DISPLAY_NAME,
  findTombstone,
  groupStateFromRecord,
  isCurrentMember,
  keyEpochEntryId,
  memberEntryId,
  normalizeDisplayName,
  signOriginBinding,
  type GroupStateDocument,
} from './group-state.js';
import {
  createGroupKeyMaterial,
  keyCommitment,
  MAX_KEY_GENERATIONS,
  withGroupKey,
  type ClusterSecretStore,
  type GroupKeyMaterial,
} from './group-store.js';
import type { ClusterGroupSettings } from './group-settings.js';
import { summarizeError } from '../utils/error-display.js';
import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
import { grantGeneration, type AdmissionFailure } from './group-admissions.js';
import { authorityKey, emptyAuthorityRecord, type AnyAuthorityEntry } from './authority-record.js';
import type { AdmissionGrant } from './group-membership.js';
import { ClusterMembershipOperationError, type ClusterMembershipOperation, type MembershipOperationFailure } from './membership-operation.js';

/** How long a join or a rejoin waits for the group to answer. */
export const ADMISSION_TIMEOUT_MS = 15_000;

/** Every operation returns one of these. `ok: false` always names the fix. */
export type GroupOperationResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
    readonly ok: false;
    readonly error: string;
    readonly fix: string;
    /**
     * True when this machine is out of the group and waiting will not change
     * it, as opposed to the ordinary "nobody answered yet", which resolves on
     * its own the moment another machine comes up.
     *
     * An automatic caller must not swallow this one. It is the difference
     * between a machine that will rejoin by itself and a machine that needs
     * the operator, and both look identical from the outside otherwise: a
     * healthy daemon that is simply never given any work.
     */
    readonly terminal?: boolean;
    /**
     * The admission layer's own classification, when this failure came from
     * one. Lets an automatic caller tell "nobody answered yet" (ordinary,
     * self-resolving) from "replies arrived that I could not verify" (worth
     * telling the operator, but not proof of anything).
     */
    /** `sharing-off`: a join while `cluster.enabled` is off, without the owner's yes to turning it on (`turnOnSharing`). */
    readonly failure?: AdmissionFailure | MembershipOperationFailure | 'sharing-off';
  };

function failed(
  error: string,
  fix: string,
  options: { readonly terminal?: boolean; readonly failure?: AdmissionFailure | MembershipOperationFailure | 'sharing-off' } = {},
): GroupOperationResult<never> {
  return {
    ok: false,
    error,
    fix,
    ...(options.terminal ? { terminal: options.terminal } : {}),
    ...(options.failure ? { failure: options.failure } : {}),
  };
}

/** The runtime owns cancellation/drain and serializes actual membership effects. */
async function membershipOperation<T>(context: GroupOperationsContext, work: (owner: ClusterMembershipOperation) => Promise<GroupOperationResult<T>>): Promise<GroupOperationResult<T>> {
  try { return await context.runtime.withMembershipOperation(work); }
  catch (error) {
    if (!(error instanceof ClusterMembershipOperationError)) throw error;
    return failed(error.message, error.kind === 'persistence-unknown'
      ? 'do not blindly retry: inspect cluster status and the membership store, then restart to reconcile the saved result'
      : 'wait for the current group operation to finish, or restart the runtime before trying again', { failure: error.kind });
  }
}

/** One machine, as `cluster nodes` reports it. */
export interface NodeReport {
  readonly nodeId: string;
  readonly displayName: string;
  readonly admittedAt: number;
  /**
   * When this machine last heard it. When `heardSinceStart` is false nothing
   * has been heard from it since this machine started listening, and this is
   * when it started listening (or now, when it is not on the network).
   */
  readonly lastSeenAt: number;
  /** False when nothing has been heard from it since this machine started listening. */
  readonly heardSinceStart: boolean;
  readonly isThisMachine: boolean;
}

/** One removal, as `cluster nodes` reports it. */
export interface RemovedNodeReport {
  readonly nodeId: string;
  readonly removedAt: number;
  readonly reason: string;
}

/** What `cluster status` reports. Contains no key material of any kind. */
export interface GroupStatusReport {
  readonly membership: 'no-group' | 'member' | 'unreadable-key-material';
  readonly groupId: string | null;
  readonly groupName: string | null;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly version: string;
  readonly memberCount: number;
  /** Null when the per-surface layer has not supplied it, never a fabricated empty list. */
  readonly surfaces: readonly SurfaceHolding[] | null;
  readonly keyGeneration: number | null;
  readonly keyGenerationsHeld: number;
  readonly keyGenerationCap: number;
  readonly acceptedGenerations: readonly number[];
  readonly removedNodeCount: number;
  readonly rotationHours: number;
  /** Replicated settings: counts and provenance only, never a value. */
  readonly replication: ConfigReplicationStatus | null;
  /**
   * The election timing in force here: heartbeat, master timeout and boot
   * probe, with every setting a rule raised or lowered from its stored value.
   * Null when the election layer has not supplied it.
   */
  readonly electionTiming?: ClusterElectionTiming | null | undefined;
  readonly wire: {
    readonly sent: number;
    readonly received: number;
    readonly droppedOtherGroup: number;
    readonly droppedBadSignature: number;
    readonly droppedMalformed: number;
    readonly droppedOldGeneration: number;
    readonly droppedNoGroup: number;
  } | null;
  /**
   * Set while this machine is in no group because a member of its last group
   * told it, verifiably, that the group removed it.
   */
  readonly removedFrom: { readonly groupId: string; readonly groupName: string | null; readonly at: number; readonly reason: string } | null;
  /**
   * The authority record (device tokens, users, grants, peer tokens): its head
   * here and the members whose record differs. Null when this daemon carries none.
   */
  readonly authority: {
    readonly revision: number; readonly digest: string; readonly behind: boolean; readonly behindOn: readonly string[];
    /**
     * Usernames held by separate accounts made on different machines before
     * they joined (owner decision D2): reported, never merged or overwritten.
     */
    readonly userConflicts?: readonly string[] | undefined;
    /**
     * What this machine dropped when it returned after longer than
     * `cluster.revocationRetentionMinutes` (or first synced with this group):
     * entries the group no longer held, removed while it was away.
     */
    readonly droppedOnReturn?: { readonly at: number; readonly count: number; readonly keys: readonly string[] } | null | undefined;
  } | null;
  /**
   * How this machine's election traffic is authenticated: by the group key
   * inside a group; outside one by `cluster.secret` (`secret`), deliberately
   * not at all (`none`), or `unavailable` when `cluster.secret` names a
   * secret that cannot be read, in which case no election traffic is sent or
   * taken until it can.
   */
  readonly electionAuthentication: 'group-key' | 'secret' | 'none' | 'unavailable';
  /** One plain sentence naming what to do, when there is something to do. */
  readonly advice: string | null;
}

export interface GroupOperationsContext {
  readonly runtime: ClusterGroupRuntime;
  readonly secrets: ClusterSecretStore;
  readonly settings: ClusterGroupSettings;
  readonly nodeId: string;
  readonly nodeDisplayName: string;
  readonly version: string;
  readonly now: () => number;
  /** The state of `cluster.secret`, which authenticates election traffic outside a group. Absent: not set. */
  readonly electionSecret?: (() => 'none' | 'set' | 'unavailable') | undefined;
  /** The authority record, for `cluster publish|accept user:<name>` (owner decision D2). */
  readonly authorityRecord?: AuthorityRecordFile | undefined;
  /** Saves `cluster.enabled` true, for a join the owner said yes to while sharing was off; applied at the next start. */
  readonly enableSharing?: (() => void) | undefined;
}

/**
 * Read-only view of the group.
 *
 * Deliberately says `no-group` rather than pretending to be a degraded member:
 * `cluster.enabled` with nothing stored is a real, nameable state, and the
 * advice line names the two commands that leave it.
 */
export function groupStatus(context: GroupOperationsContext): GroupOperationResult<GroupStatusReport> {
  const { runtime } = context;
  const state = runtime.groupState;
  const material = runtime.keyMaterial;
  const membership = runtime.membership;
  const removedFrom = membership === 'no-group' ? runtime.removedFrom : null;
  const secret = context.electionSecret?.() ?? 'none';
  const electionAuthentication = membership === 'member' ? 'group-key' : secret === 'set' ? 'secret' : secret;
  const advice = !context.settings.enabled
    ? 'sharing inbound work with your other machines is switched off here, turn it on with `config set cluster.enabled true`'
    : membership === 'no-group' && removedFrom
      ? `this machine was removed from the group${removedFrom.groupName ? ` "${removedFrom.groupName}"` : ''} [${removedFrom.groupId}] by another member; to put it back, run \`cluster key\` on a machine in that group, then \`cluster join --group ${removedFrom.groupId}\` here and give it that key`
    : membership === 'no-group'
      ? 'this machine is not in a group yet, run `cluster create` here, or `cluster join` to join one that already exists'
      : membership === 'unreadable-key-material'
        ? 'group membership storage could not be confirmed; it is read again every 30 seconds, so check the secrets store and keyfile; a restart reads it at once. Inspect `cluster status` before joining again'
        : null;
  return {
    ok: true,
    data: {
      membership,
      groupId: material?.groupId ?? null,
      groupName: state?.displayName ?? null,
      nodeId: context.nodeId,
      nodeName: context.nodeDisplayName,
      version: context.version,
      memberCount: state?.members.length ?? 0,
      surfaces: runtime.surfaceHoldings(),
      keyGeneration: material ? runtime.keyring().currentGeneration : null,
      keyGenerationsHeld: material?.keys.length ?? 0,
      keyGenerationCap: MAX_KEY_GENERATIONS,
      acceptedGenerations: runtime.keyring().acceptedGenerations(),
      removedNodeCount: state?.tombstones.length ?? 0,
      rotationHours: context.settings.keyRotationHours,
      replication: runtime.replicationStatus(),
      electionTiming: runtime.electionTiming(),
      wire: runtime.wireCounters ? { ...runtime.wireCounters } : null,
      removedFrom,
      authority: runtime.authorityStatus(),
      electionAuthentication,
      advice,
    },
  };
}

export interface CreateGroupInput {
  readonly displayName?: string | undefined;
  /**
   * An operator-chosen join key instead of a generated one.
   *
   * Run through scrypt with the group's salt, because a phrase a human picked
   * has far less entropy than the generated key and the derivation is the only
   * thing standing between it and an offline guess.
   */
  readonly passphrase?: string | undefined;
}

export interface CreateGroupResult {
  readonly groupId: string;
  readonly groupName: string;
  readonly joinKey: string;
  readonly generatedKey: boolean;
}

/** Create a group with this machine as its first member. */
export function createGroup(context: GroupOperationsContext, input: CreateGroupInput): Promise<GroupOperationResult<CreateGroupResult>> {
  const captured = { ...input };
  return membershipOperation(context, owner => createGroupOwned(context, captured, owner));
}

async function createGroupOwned(
  context: GroupOperationsContext,
  input: CreateGroupInput,
  owner: ClusterMembershipOperation,
): Promise<GroupOperationResult<CreateGroupResult>> {
  if (context.runtime.membership === 'member') {
    return failed(
      'this machine is already in a group',
      'leave it first with `cluster leave`, or use `cluster key` to add another machine to the group it is in',
    );
  }
  const passphrase = input.passphrase?.trim();
  if (passphrase !== undefined && passphrase.length > 0 && passphrase.length < 12) {
    return failed(
      'that join phrase is too short to be worth having',
      'use at least 12 characters, or leave it out and a strong key will be generated',
    );
  }
  const groupId = generateGroupId();
  const joinSalt = deriveJoinSalt(groupId);
  const joinKey = passphrase && passphrase.length > 0 ? passphrase : generateJoinKey();
  const joinVerifier = await deriveJoinVerifier(joinKey, joinSalt);
  context.runtime.assertMembershipOperation(owner);
  const now = context.now();

  const material = createGroupKeyMaterial({
    groupId,
    joinKey,
    joinSalt,
    joinVerifier,
    nodeId: context.nodeId,
    now,
  });
  const displayName = normalizeDisplayName(input.displayName, DEFAULT_GROUP_DISPLAY_NAME);
  const first = material.keys[0]!;
  // The group's first record entries: its name, this machine as its first
  // member, and generation 0 with the signing key and join verifier in force,
  // so every member that ever joins holds them.
  await context.runtime.adoptMembership(material, { kind: 'issue', drafts: [
    { kind: 'group', id: groupId, public: { groupId, displayName } },
    { kind: 'member', id: memberEntryId(groupId, context.nodeId, 1), public: {
      nodeId: context.nodeId, gen: 1, displayName: normalizeDisplayName(context.nodeDisplayName, context.nodeId.slice(0, 8)),
      identityKey: material.node.identity.publicKey, agreementKey: material.node.agreement.publicKey, admittedAt: Math.trunc(now),
      // This home's record id, bound by this machine's identity key (rule 7).
      authorityOrigin: context.runtime.authorityOrigin,
      originProof: signOriginBinding(material.node.identity, groupId, context.nodeId, context.runtime.authorityOrigin),
    } },
    { kind: 'key-epoch', id: keyEpochEntryId(groupId, 0), public: {
      epoch: 0, cause: 'scheduled', mintedBy: context.nodeId, createdAt: first.createdAt,
      keyCommitment: keyCommitment(groupId, 0, first.key),
      signing: { publicKey: material.groupSigning.publicKey, generation: material.groupSigning.generation },
      joinVerifier,
    } },
  ] }, owner);
  return {
    ok: true,
    data: {
      groupId,
      groupName: displayName,
      joinKey,
      generatedKey: !passphrase || passphrase.length === 0,
    },
  };
}

export interface JoinGroupInput {
  readonly groupId: string;
  readonly joinKey: string;
  readonly timeoutMs?: number | undefined;
  /**
   * The owner's yes, asked by the caller (opening on No), to turn sharing on
   * (`cluster.enabled`) when it is off: the join is stored as pending, sharing
   * is set on, and the join finishes at the daemon's next start.
   */
  readonly turnOnSharing?: boolean | undefined;
}

export interface JoinGroupResult extends PendingRestartFields {
  readonly groupId: string;
  readonly groupName: string;
  readonly memberCount: number;
  /** Set when the machine joined but something after joining did not complete; for a pending join, what happens next. */
  readonly warning?: string;
}

/**
 * The secret-store name of a group action that finishes at the daemon's next
 * start: one the owner asked for while sharing was off, kept while sharing is
 * turned on and the daemon restarts to bring the group up. A secret because a
 * join carries its join key.
 */
export const PENDING_GROUP_ACTION_SECRET_KEY = daemonSecretKeyFor('cluster.pendingAction');

/** A group action stored to finish at the next start. */
export type PendingGroupAction =
  | { readonly kind: 'join'; readonly groupId: string; readonly joinKey: string; readonly at: number }
  | { readonly kind: 'forget'; readonly nodeId: string; readonly at: number }
  | { readonly kind: 'rotate'; readonly immediate: boolean; readonly at: number }
  | { readonly kind: 'rename'; readonly name: string; readonly at: number }
  | { readonly kind: 'publish' | 'accept'; readonly path: string; readonly at: number };

/** The pending action, or null; an unreadable or malformed one reads as null. */
export async function readPendingGroupAction(secrets: ClusterSecretStore): Promise<PendingGroupAction | null> {
  let raw: string | null;
  try { raw = await secrets.get(PENDING_GROUP_ACTION_SECRET_KEY); } catch { return null; }
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    parsed = value as Record<string, unknown>;
  } catch { return null; }
  const at = parsed['at'];
  if (typeof at !== 'number') return null;
  const text = (key: string): string | null => (typeof parsed[key] === 'string' ? parsed[key] as string : null);
  switch (parsed['kind']) {
    case 'join': {
      const groupId = text('groupId'), joinKey = text('joinKey');
      return groupId !== null && joinKey !== null ? { kind: 'join', groupId, joinKey, at } : null;
    }
    case 'forget': { const nodeId = text('nodeId'); return nodeId !== null ? { kind: 'forget', nodeId, at } : null; }
    case 'rotate': return { kind: 'rotate', immediate: parsed['immediate'] === true, at };
    case 'rename': { const name = text('name'); return name !== null ? { kind: 'rename', name, at } : null; }
    case 'publish':
    case 'accept': { const path = text('path'); return path !== null ? { kind: parsed['kind'], path, at } : null; }
    default: return null;
  }
}

/** Forget the pending action. */
export async function clearPendingGroupAction(secrets: ClusterSecretStore): Promise<void> {
  await secrets.delete(PENDING_GROUP_ACTION_SECRET_KEY);
}

/** What a group action answers once it is kept to finish after the restart that brings the group up. */
export interface PendingRestartFields {
  /** True when the action is stored and finishes after the daemon restarts (sharing was just turned on). */
  readonly pending?: true;
  /** For a pending action: the daemon restarting itself, or started by hand (the person restarts it), or its restart refused. */
  readonly restart?: 'restarting' | 'by-hand' | 'failed';
  /** For a pending action: what happens next, in the person's words. */
  readonly warning?: string;
}

/** The words a group action with sharing off answers when the caller did not bring the owner's yes. */
export const SHARING_OFF_FOR_JOIN = 'sharing inbound work with your other machines is switched off on this machine';
export const SHARING_OFF_JOIN_FIX = 'join again and answer yes to turning sharing on (or pass --yes): the join is kept and finishes when the daemon restarts';
/** The same refusal for forget, rotate, rename, publish and accept. */
export const SHARING_OFF_ACTION_FIX = 'run it again and answer yes to turning sharing on (or pass --yes): it is kept and finishes when the daemon restarts';

/**
 * Keep an action asked for while sharing is off: written and read back before
 * anything else changes, then sharing is set on. A stop after the write leaves
 * the action for the next start, which drops it (and says so) when sharing was
 * never set, and finishes it when it was.
 */
async function keepForRestart(context: GroupOperationsContext, action: PendingGroupAction): Promise<GroupOperationResult<null>> {
  if (!context.enableSharing) return failed(SHARING_OFF_FOR_JOIN, SHARING_OFF_ACTION_FIX, { failure: 'sharing-off' });
  await context.secrets.set(PENDING_GROUP_ACTION_SECRET_KEY, JSON.stringify(action));
  const stored = await readPendingGroupAction(context.secrets);
  if (stored === null || JSON.stringify(stored) !== JSON.stringify(action)) {
    return failed('the action could not be kept in this daemon\'s secret store, so sharing was not turned on', 'check the secret store, then run it again');
  }
  context.enableSharing();
  return { ok: true, data: null };
}

/** The refusal (or the kept action) of a group action asked for while sharing is off. */
async function whileSharingOff<T>(
  context: GroupOperationsContext,
  turnOnSharing: boolean | undefined,
  action: PendingGroupAction,
  placeholder: T,
): Promise<GroupOperationResult<T & PendingRestartFields>> {
  if (turnOnSharing !== true) return failed(SHARING_OFF_FOR_JOIN, SHARING_OFF_ACTION_FIX, { failure: 'sharing-off' });
  const kept = await keepForRestart(context, action);
  if (!kept.ok) return kept;
  return { ok: true, data: { ...placeholder, pending: true } };
}

/**
 * Join an existing group.
 *
 * The group id names WHICH group, and the join key proves the right to be in
 * it. Both are needed: the id alone is public (it is in every beacon) and the
 * key alone would not say which group it was for.
 */
export function joinGroup(context: GroupOperationsContext, input: JoinGroupInput): Promise<GroupOperationResult<JoinGroupResult>> {
  const captured = { ...input };
  return membershipOperation(context, owner => joinGroupOwned(context, captured, owner));
}

async function joinGroupOwned(
  context: GroupOperationsContext,
  input: JoinGroupInput,
  owner: ClusterMembershipOperation,
): Promise<GroupOperationResult<JoinGroupResult>> {
  if (!context.settings.enabled) {
    const groupId = input.groupId.trim();
    const joinKey = normalizeJoinKey(input.joinKey ?? '');
    if (input.turnOnSharing !== true || !context.enableSharing) return failed(SHARING_OFF_FOR_JOIN, SHARING_OFF_JOIN_FIX, { failure: 'sharing-off' });
    if (groupId.length === 0 || joinKey.length === 0) return failed('a group id and a join key are both required', 'run `cluster join` again and give both');
    const kept = await keepForRestart(context, { kind: 'join', groupId, joinKey, at: Math.trunc(context.now()) });
    if (!kept.ok) return kept;
    return { ok: true, data: { groupId, groupName: '', memberCount: 0, pending: true } };
  }
  // A machine that still holds this same group's membership may join it again
  // with the current join key: that is how a machine that was removed while it
  // was away, or that holds keys the group no longer accepts, is put back
  // without `cluster leave`. Only a DIFFERENT group needs leaving first.
  const heldGroup = context.runtime.membership === 'member' ? context.runtime.keyMaterial?.groupId ?? null : null;
  if (heldGroup !== null && heldGroup !== input.groupId.trim()) {
    return failed(
      'this machine is already in a group',
      'run `cluster leave` first if you mean to move it to a different one',
    );
  }
  const joinKey = normalizeJoinKey(input.joinKey ?? '');
  if (joinKey.length === 0) {
    return failed('no join key was given', 'run `cluster key` on a machine already in the group to see it');
  }
  const groupId = input.groupId.trim();
  if (groupId.length === 0) {
    return failed(
      'no group was named',
      'run `cluster join` with no arguments to pick from the groups on this network, or pass --group',
    );
  }
  const outcome = await context.runtime.requestJoin({
    groupId,
    joinKey,
    joinSalt: deriveJoinSalt(groupId),
    timeoutMs: input.timeoutMs ?? ADMISSION_TIMEOUT_MS,
  });
  if (!outcome.ok) {
    // A machine presenting the WRONG join key cannot tell a refusal apart from
    // silence: the refusal is authenticated with the real key, which by
    // definition it does not hold. So a timeout covers both cases and the
    // message says both rather than guessing at one and being wrong half the
    // time.
    const timedOut = outcome.failure === 'unanswered';
    return failed(
      timedOut
        ? 'no machine in that group accepted the join key, either the join key is wrong, or no machine in that group is reachable on this network'
        : outcome.reason,
      'check the join key with `cluster key` on a machine already in the group, and that both machines are on the same network',
      { failure: outcome.failure },
    );
  }
  context.runtime.assertMembershipOperation(owner);
  const grant = outcome.grant;
  const now = context.now();
  // The keys the granting member accepts; which of them this machine signs
  // with and accepts is computed from the record entries that came with them,
  // so a generation the group closed (a removal) stays closed here too.
  const material: GroupKeyMaterial = {
    version: 1,
    groupId,
    joinKey: grant.joinKey,
    joinSalt: grant.joinSalt,
    joinVerifier: grant.joinVerifier,
    keys: grant.keys.map((record) => ({ ...record, adoptedAt: Math.trunc(now) })),
    node: outcome.node,
    groupSigning: grant.groupSigning,
  };
  await context.runtime.adoptMembership(material, { kind: 'absorb', entries: grant.entries }, owner);
  const roster = grantRoster(groupId, grant);
  // Ask for the group's settings straight away: a machine that has joined but
  // holds none of them cannot serve a surface it might win in a few seconds.
  // The membership is already saved, so a failed request is not a failed join:
  // reporting one would have the operator retry and be told the machine is
  // already in a group. Housekeeping keeps asking until the settings arrive.
  let warning: string | undefined;
  if (!owner.signal.aborted) {
    // The rest of the group's record (devices, users, grants) comes the same
    // way, from every member, signed with identity keys.
    context.runtime.catchUp();
    try {
      await context.runtime.requestConfigSnapshot();
    } catch (error) {
      warning = `this machine joined the group, but its first request for the group's settings did not go out (${summarizeError(error)}); it asks again on its own`;
    }
  }
  return {
    ok: true,
    data: {
      groupId,
      groupName: roster.displayName,
      memberCount: roster.members.length,
      ...(warning !== undefined ? { warning } : {}),
    },
  };
}

/** The roster a grant's record entries describe. */
function grantRoster(groupId: string, grant: AdmissionGrant): GroupStateDocument {
  const record = emptyAuthorityRecord({ groupId });
  const entries = new Map(record.entries);
  for (const entry of grant.entries) entries.set(authorityKey(entry.kind, entry.id), entry as AnyAuthorityEntry);
  return groupStateFromRecord({ ...record, entries }, groupId);
}

export interface JoinKeyResult {
  readonly groupId: string;
  readonly groupName: string;
  readonly joinKey: string;
}

/**
 * Show the join key.
 *
 * On demand and repeatable, from any member, not a one-shot reveal at create
 * time. A key you can only see once is a key that gets written on a sticky
 * note, and the operator adding a fourth machine six months later has every
 * right to just ask for it again.
 */
export function joinKeyForGroup(context: GroupOperationsContext): GroupOperationResult<JoinKeyResult> {
  const material = context.runtime.keyMaterial;
  const state = context.runtime.groupState;
  if (!material || !state) {
    return failed(
      'this machine is not in a group, so it has no join key to show',
      'create a group with `cluster create`, or join one with `cluster join`',
    );
  }
  return {
    ok: true,
    data: { groupId: material.groupId, groupName: state.displayName, joinKey: material.joinKey },
  };
}

export interface NodesResult {
  readonly groupId: string;
  readonly groupName: string;
  readonly members: readonly NodeReport[];
  readonly removed: readonly RemovedNodeReport[];
}

/** The roster. */
export function groupNodes(context: GroupOperationsContext): GroupOperationResult<NodesResult> {
  const state = context.runtime.groupState;
  const material = context.runtime.keyMaterial;
  if (!state || !material) {
    return failed(
      'this machine is not in a group, so there is no member list',
      'create a group with `cluster create`, or join one with `cluster join`',
    );
  }
  return {
    ok: true,
    data: {
      groupId: material.groupId,
      groupName: state.displayName,
      members: state.members.map((member) => {
        const isThisMachine = member.nodeId === context.nodeId;
        const heard = isThisMachine ? context.now() : context.runtime.lastHeardFrom(member.nodeId);
        return {
          nodeId: member.nodeId,
          // This machine's own row shows its configured name (cluster.nodeName), which other machines learn when it joins.
          displayName: isThisMachine ? context.nodeDisplayName : member.displayName,
          admittedAt: member.admittedAt,
          lastSeenAt: heard ?? context.runtime.listeningStartedAt ?? context.now(),
          heardSinceStart: heard !== null,
          isThisMachine,
        };
      }),
      removed: state.tombstones.map((entry) => ({
        nodeId: entry.nodeId,
        removedAt: entry.at,
        reason: entry.reason,
      })),
    },
  };
}

export interface ForgetNodeResult extends PendingRestartFields {
  readonly nodeId: string;
  readonly displayName: string;
  readonly memberCount: number;
  readonly keyGeneration: number;
  /**
   * True when the group's join key was replaced as well. A machine that is
   * added later needs the NEW key, shown by `cluster key`; the removed machine
   * holds only the old one.
   */
  readonly joinKeyReplaced?: boolean;
}

/**
 * Remove a machine from the group.
 *
 * Two things happen, in ONE write of the authority record, and both are
 * required. The machine's membership entry is REVOKED, a terminal fact no copy
 * that missed it can undo, so a peer that was partitioned during the removal
 * cannot bring the machine back when it reconnects. And a new key generation,
 * minted by a revocation, opens no acceptance window on any machine, so the key
 * still sitting on that machine's disk stops being accepted by everyone who
 * takes the new generation.
 *
 * The new generation replaces the JOIN key and the group SIGNING key too.
 * Without that the removed machine, which still holds the join key, could
 * present it to any member and be put straight back. To undo a removal on
 * purpose, give the machine the new join key from `cluster key`.
 *
 * The removed machine is told: the record change is signed with identity keys
 * that never rotate, so it checks the revocation of its own membership and
 * drops the group's keys; one that was asleep is told when it next asks.
 * Members that have not yet taken the new generation keep accepting the old
 * key for the moments it takes the change to reach them; that gap closes as it
 * propagates, and the revocation, which governs re-entry, is in force at once.
 *
 * It is one operation: it cannot overlap a join or a leave, and when the key
 * cannot be saved nothing is written to the record, so the machine is not
 * half removed.
 */
export function forgetNode(
  context: GroupOperationsContext,
  nodeId: string,
  options: { readonly turnOnSharing?: boolean | undefined } = {},
): Promise<GroupOperationResult<ForgetNodeResult>> {
  return membershipOperation(context, owner => forgetNodeOwned(context, nodeId, owner, options.turnOnSharing));
}

async function forgetNodeOwned(
  context: GroupOperationsContext,
  nodeId: string,
  owner: ClusterMembershipOperation,
  turnOnSharing?: boolean,
): Promise<GroupOperationResult<ForgetNodeResult>> {
  if (!context.settings.enabled) {
    // A removal must reach the group: it is kept, sharing is turned on, and it finishes once the group is up.
    return whileSharingOff(context, turnOnSharing, { kind: 'forget', nodeId, at: Math.trunc(context.now()) },
      { nodeId, displayName: nodeId, memberCount: 0, keyGeneration: 0 });
  }
  const state = context.runtime.groupState;
  if (!state || !context.runtime.keyMaterial) {
    return failed(
      'this machine is not in a group',
      'create a group with `cluster create`, or join one with `cluster join`',
    );
  }
  // The operator names a machine by its full id, its display name, or an id
  // prefix. An exact id wins; otherwise the name or prefix must pick out one
  // machine, since removing the wrong one is not undone by running it again.
  const exact = state.members.find((entry) => entry.nodeId === nodeId);
  const byName = state.members.filter((entry) => entry.displayName === nodeId);
  const byPrefix = state.members.filter((entry) => entry.nodeId.startsWith(nodeId));
  const candidates = exact ? [exact] : byName.length > 0 ? byName : byPrefix;
  if (candidates.length > 1) {
    return failed(
      `'${nodeId}' matches ${candidates.length} machines in this group: ${candidates.map((entry) => `${entry.nodeId} (${entry.displayName})`).join(', ')}`,
      'run `cluster forget` again with the full node id; `cluster nodes` lists them',
    );
  }
  const member = candidates[0];
  if (!member) {
    return failed(
      `no machine called '${nodeId}' is in this group`,
      'run `cluster nodes` to see the member list',
    );
  }
  if (member.nodeId === context.nodeId) {
    return failed(
      'a machine cannot remove itself from the group',
      'run `cluster leave` on this machine instead, or `cluster forget` from another machine in the group',
    );
  }
  // The replacement join key is minted before the removal is recorded, so
  // nothing waits between telling the group the machine is gone and taking its
  // join key away; the removal record names the key it replaces.
  const plan = await context.runtime.prepareRevocation();
  context.runtime.assertMembershipOperation(owner);
  const current = context.runtime.groupState;
  if (!current || !isCurrentMember(current, member.nodeId)) {
    return failed(
      `'${member.displayName}' is no longer on this machine's roster`,
      'run `cluster nodes` to see the member list',
    );
  }
  // The removal and the generation that shuts the machine out are one record
  // write: the group never holds one without the other.
  let rotated: { readonly generation: number };
  try {
    rotated = await context.runtime.rotate('revocation', `${member.nodeId} was removed from the group`, plan, { nodeId: member.nodeId });
  } catch (error) {
    const kind = error instanceof ClusterMembershipOperationError ? error.kind : undefined;
    return failed(
      `'${member.displayName}' was not removed: the group key could not be replaced (${summarizeError(error)})`,
      kind === 'persistence-unknown'
        ? 'do not blindly retry: inspect cluster status and the membership store, then restart to reconcile the saved result'
        : 'run `cluster forget` again',
      kind ? { failure: kind } : {},
    );
  }
  return {
    ok: true,
    data: {
      nodeId: member.nodeId,
      displayName: member.displayName,
      memberCount: context.runtime.groupState?.members.length ?? 0,
      keyGeneration: rotated.generation,
      joinKeyReplaced: true,
    },
  };
}

export interface RotateKeyResult extends PendingRestartFields {
  readonly groupId: string;
  readonly keyGeneration: number;
  readonly memberCount: number;
  readonly immediate: boolean;
  readonly acceptedGenerations: readonly number[];
  /** True when the join key was replaced too (an immediate rotation); `cluster key` shows the new one. */
  readonly joinKeyReplaced?: boolean;
}

/**
 * Replace the group key now, because the operator said so.
 *
 * Two shapes, and the difference is what happens to the key being retired:
 *
 *   default, the outgoing generation stays accepted for the usual few minutes,
 *     so machines that have not yet picked up the new key keep being heard and
 *     nothing is interrupted. This is the right answer for routine hygiene.
 *
 *   --now, the outgoing generation stops being accepted immediately, and the
 *     group's SIGNING key and JOIN key are replaced as well. This is the answer
 *     when a key is believed to have leaked: whatever was taken stops working the
 *     moment each machine takes the replacement, a machine which is asleep right
 *     now takes it from the group when it wakes, and a machine to be added needs
 *     the new join key from `cluster key`.
 */
export function rotateGroupKey(
  context: GroupOperationsContext,
  input: { readonly immediate?: boolean | undefined; readonly turnOnSharing?: boolean | undefined } = {},
): Promise<GroupOperationResult<RotateKeyResult>> {
  const captured = { ...input };
  return membershipOperation(context, owner => rotateGroupKeyOwned(context, captured, owner));
}

async function rotateGroupKeyOwned(
  context: GroupOperationsContext,
  input: { readonly immediate?: boolean | undefined; readonly turnOnSharing?: boolean | undefined },
  owner: ClusterMembershipOperation,
): Promise<GroupOperationResult<RotateKeyResult>> {
  const material = context.runtime.keyMaterial;
  if (!material) {
    return failed(
      'this machine is not in a group, so there is no group key to replace',
      'create a group with `cluster create`, or join one with `cluster join`',
    );
  }
  if (!context.settings.enabled) {
    // The new key must reach the group: it is kept, sharing is turned on, and it is replaced once the group is up.
    return whileSharingOff(context, input.turnOnSharing, { kind: 'rotate', immediate: input.immediate === true, at: Math.trunc(context.now()) },
      { groupId: material.groupId, keyGeneration: 0, memberCount: 0, immediate: input.immediate === true, acceptedGenerations: [] });
  }
  const immediate = input.immediate === true;
  context.runtime.assertMembershipOperation(owner);
  let rotated: { readonly generation: number };
  try {
    rotated = await context.runtime.rotate(
      immediate ? 'revocation' : 'scheduled',
      immediate ? 'replaced immediately by the operator' : 'replaced by the operator',
    );
  } catch (error) {
    if (error instanceof ClusterMembershipOperationError) throw error;
    return failed(
      `the group key could not be replaced: ${summarizeError(error)}`,
      'inspect cluster status, then try again',
    );
  }
  return {
    ok: true,
    data: {
      groupId: material.groupId,
      keyGeneration: rotated.generation,
      memberCount: context.runtime.groupState?.members.length ?? 0,
      immediate,
      acceptedGenerations: context.runtime.keyring().acceptedGenerations(),
      ...(immediate ? { joinKeyReplaced: true } : {}),
    },
  };
}

export interface LeaveGroupResult {
  readonly groupId: string;
  readonly groupName: string;
}

/**
 * Leave the group, from this machine.
 *
 * This forgets the group HERE. It does not remove this machine from the other
 * members' rosters, they will simply stop hearing from it, and the operator
 * can tidy up with `cluster forget` on any of them. Making one machine's
 * decision to leave silently rewrite everyone else's membership would be a
 * strictly worse default.
 */
export function leaveGroup(context: GroupOperationsContext): Promise<GroupOperationResult<LeaveGroupResult>> {
  return membershipOperation(context, owner => leaveGroupOwned(context, owner));
}

async function leaveGroupOwned(context: GroupOperationsContext, owner: ClusterMembershipOperation): Promise<GroupOperationResult<LeaveGroupResult>> {
  const material = context.runtime.keyMaterial;
  const state = context.runtime.groupState;
  if (!material || !state) {
    return failed('this machine is not in a group', 'there is nothing to leave');
  }
  const result = { groupId: material.groupId, groupName: state.displayName };
  await context.runtime.leaveMembership(owner);
  return { ok: true, data: result };
}

export interface RenameGroupResult extends PendingRestartFields {
  readonly groupId: string;
  readonly groupName: string;
}

/**
 * Rename the group.
 *
 * The name is replicated group state, so renaming on any machine renames it
 * everywhere. It is also what the discovery beacon advertises, which means it
 * is visible to anything on the network, the setting's description says so
 * plainly, and the default is neutral for that reason.
 */
export function renameGroupTo(
  context: GroupOperationsContext,
  displayName: string,
  options: { readonly turnOnSharing?: boolean | undefined } = {},
): Promise<GroupOperationResult<RenameGroupResult>> {
  return membershipOperation(context, async (owner): Promise<GroupOperationResult<RenameGroupResult>> => {
    const state = context.runtime.groupState;
    const material = context.runtime.keyMaterial;
    if (!state || !material) {
      return failed('this machine is not in a group', 'create a group with `cluster create` first');
    }
    if (!context.settings.enabled) {
      // A new name must reach the group: it is kept, sharing is turned on, and it is given once the group is up.
      return whileSharingOff(context, options.turnOnSharing, { kind: 'rename', name: displayName, at: Math.trunc(context.now()) },
        { groupId: material.groupId, groupName: displayName });
    }
    context.runtime.assertMembershipOperation(owner);
    const groupName = await context.runtime.renameGroup(displayName);
    return { ok: true, data: { groupId: material.groupId, groupName } };
  });
}

/** What `cluster publish` or `cluster accept` did with one shared setting. */
export interface SettingDecisionResult extends PendingRestartFields {
  readonly path: string;
  /** `held` when this machine does not hold the group's settings yet: the value is sent once it does. */
  readonly decision: 'published' | 'held' | 'accepted';
  /** For `user:<name>`: the account ids revoked so the name has one account in the group. */
  readonly revoked?: readonly string[] | undefined;
}

/**
 * The owner's answer to a local difference (`cluster status` lists them):
 * `publish` sends this machine's value of the shared setting to the group,
 * `accept` takes the group's value here.
 */
export async function decideLocalSetting(
  context: GroupOperationsContext,
  path: string,
  decision: 'publish' | 'accept',
  options: { readonly turnOnSharing?: boolean | undefined } = {},
): Promise<GroupOperationResult<SettingDecisionResult>> {
  if (!context.runtime.groupState || !context.runtime.keyMaterial) {
    return failed('this machine is not in a group', 'there is no group setting to send to or take from; `cluster create` or `cluster join` first');
  }
  if (!context.settings.enabled) {
    // Nothing reaches or comes from the group while sharing is off: the decision is kept and made once the group is up.
    return whileSharingOff(context, options.turnOnSharing, { kind: decision, path, at: Math.trunc(context.now()) },
      { path, decision: decision === 'publish' ? 'published' as const : 'accepted' as const });
  }
  try {
    // `user:<name>`: a username held by separate accounts made on different
    // machines; publish makes this machine's account the group's, accept takes
    // the group's account here.
    if (path.startsWith('user:')) {
      if (!context.authorityRecord) return failed('this daemon carries no authority record', 'restart the daemon');
      const decided = await decideUserAccount(context.authorityRecord, path.slice('user:'.length), decision);
      return { ok: true, data: { path, decision: decided.decision, revoked: decided.revoked } };
    }
    if (decision === 'accept') {
      await context.runtime.acceptGroupConfigValue(path);
      return { ok: true, data: { path, decision: 'accepted' } };
    }
    return { ok: true, data: { path, decision: await context.runtime.publishConfigValue(path) } };
  } catch (error) {
    if (error instanceof UserAccountDecisionError) {
      return failed(error.message, 'run `cluster status` to see which usernames are held by separate accounts');
    }
    if (error instanceof ConfigLocalDifferenceError) {
      return failed(error.message, 'run `cluster status` to see which shared settings differ on this machine');
    }
    if (error instanceof ClusterMembershipOperationError) {
      return failed(error.message, 'wait for the current group operation to finish, then try again', { failure: error.kind });
    }
    throw error;
  }
}

/** Groups seen advertising themselves on this network that this machine is not in. */
export function groupsOnTheNetwork(context: GroupOperationsContext): GroupOperationResult<readonly DiscoveredGroup[]> {
  return { ok: true, data: context.runtime.groupsOnTheNetwork() };
}

/**
 * Ask the group to take this machine back (REJOIN).
 *
 * Called on start by a machine that holds key material but whose own record no
 * longer lists it (the record was lost). A machine its record does list takes
 * the group's record and newest key generation by an identity-signed request
 * instead (`ClusterGroupRuntime.catchUp`). No verb or route exposes it.
 * Succeeds only if the node id is still on the group's roster, see
 * `decideAdmission`.
 */
export function rejoinGroup(context: GroupOperationsContext, atLeast = 0): Promise<GroupOperationResult<JoinGroupResult>> {
  return membershipOperation(context, owner => rejoinGroupOwned(context, owner, atLeast));
}

async function rejoinGroupOwned(context: GroupOperationsContext, owner: ClusterMembershipOperation, atLeast: number): Promise<GroupOperationResult<JoinGroupResult>> {
  const material = context.runtime.keyMaterial;
  if (!material) {
    return failed('this machine is not in a group', 'join one with `cluster join`');
  }
  const outcome = await context.runtime.requestRejoin(ADMISSION_TIMEOUT_MS, atLeast);
  if (!outcome.ok && outcome.failure === 'removed') {
    // A member proved it is in the group and said the group holds a removal
    // record for this machine. This machine stops holding the group's keys,
    // says so in `cluster status`, and can be put back with `cluster join`
    // and the current join key.
    context.runtime.assertMembershipOperation(owner);
    const groupName = context.runtime.groupState?.displayName ?? null;
    await context.runtime.leaveMembership(owner);
    context.runtime.noteRemovedFromGroup({ groupId: material.groupId, groupName, at: context.now(), reason: outcome.reason });
    return failed(
      `this machine was removed from the group${groupName ? ` "${groupName}"` : ''} by another member, so it no longer holds the group's keys`,
      `to put it back, run \`cluster key\` on a machine in the group, then \`cluster join --group ${material.groupId}\` here and give it that key`,
      { terminal: true, failure: 'removed' },
    );
  }
  if (!outcome.ok) {
    // Only an AUTHENTICATED refusal is final. Replies this machine could not
    // verify are reported honestly and left non-final, because a stranger on
    // the network can produce those and must not be able to convince a machine
    // it was removed from its own group.
    return failed(
      outcome.reason,
      'if this machine was removed from the group, join it again with `cluster join` and the current join key',
      { terminal: outcome.failure === 'refused', failure: outcome.failure },
    );
  }
  context.runtime.assertMembershipOperation(owner);
  const current = context.runtime.keyMaterial;
  if (!current || current.groupId !== material.groupId || context.runtime.keyring().currentGeneration > grantGeneration(outcome.grant)) {
    return failed('the group membership changed while this machine was asking to return', 'inspect cluster status, then ask to rejoin again', { failure: 'not-sent' });
  }
  const now = context.now();
  // The answer's entries are merged into this machine's record, never laid
  // over it: a removal this machine already knows about stays (the merge keeps
  // a revocation terminal).
  let keys = current;
  for (const record of outcome.grant.keys) keys = withGroupKey(keys, { ...record, adoptedAt: Math.trunc(now) }, grantGeneration(outcome.grant), now);
  const groupSigning = outcome.grant.groupSigning.generation >= current.groupSigning.generation ? outcome.grant.groupSigning : current.groupSigning;
  await context.runtime.adoptMembership(
    { ...keys, joinKey: outcome.grant.joinKey, joinSalt: outcome.grant.joinSalt, joinVerifier: outcome.grant.joinVerifier, groupSigning },
    { kind: 'absorb', entries: outcome.grant.entries },
    owner,
  );
  const state = context.runtime.groupState;
  return {
    ok: true,
    data: {
      groupId: material.groupId,
      groupName: state?.displayName ?? DEFAULT_GROUP_DISPLAY_NAME,
      memberCount: state?.members.length ?? 0,
    },
  };
}

/**
 * This machine's own record holds the revocation of its membership (a member
 * sent the change, or answered this machine's request with it). Drop the
 * group's keys and say so, exactly as when a member refuses its return as
 * removed, so `cluster join` with the current key puts it back without `leave`.
 * A record that merely does not list this machine is not a removal and is left alone.
 */
export function acknowledgeRemoval(context: GroupOperationsContext): Promise<GroupOperationResult<{ readonly groupId: string }>> {
  return membershipOperation(context, async (owner): Promise<GroupOperationResult<{ readonly groupId: string }>> => {
    const material = context.runtime.keyMaterial;
    const state = context.runtime.groupState;
    const removal = state ? findTombstone(state, context.nodeId) : null;
    if (!material || !state || !removal) return failed('this machine holds no removal record for itself', 'nothing to do');
    const groupName = state.displayName;
    await context.runtime.leaveMembership(owner);
    context.runtime.noteRemovedFromGroup({ groupId: material.groupId, groupName, at: removal.at, reason: removal.reason });
    return { ok: true, data: { groupId: material.groupId } };
  });
}

/** True when `state` still lists this machine. Used by the start-up rejoin decision. */
export function stillOnRoster(state: GroupStateDocument | null, nodeId: string): boolean {
  return state !== null && isCurrentMember(state, nodeId);
}

/** The verb surface the daemon serves on `/api/cluster/*`. One line per operation. */
export interface ClusterGroupVerbSurface {
  status(): GroupOperationResult<GroupStatusReport>;
  create(input: { name?: string; passphrase?: string }): Promise<GroupOperationResult<CreateGroupResult>>;
  join(input: { groupId: string; joinKey: string }): Promise<GroupOperationResult<JoinGroupResult>>;
  key(): GroupOperationResult<JoinKeyResult>;
  nodes(): GroupOperationResult<NodesResult>;
  groups(): GroupOperationResult<readonly DiscoveredGroup[]>;
  /** `turnOnSharing` on these five: the owner's yes to turning sharing on when it is off; the action then finishes after a restart. */
  forget(nodeId: string, options?: { turnOnSharing?: boolean }): Promise<GroupOperationResult<ForgetNodeResult>>;
  rotate(input: { immediate?: boolean; turnOnSharing?: boolean }): Promise<GroupOperationResult<RotateKeyResult>>;
  leave(): Promise<GroupOperationResult<LeaveGroupResult>>;
  rename(name: string, options?: { turnOnSharing?: boolean }): Promise<GroupOperationResult<RenameGroupResult>>;
  /** Send this machine's value of a shared setting to the group. */
  publish(path: string, options?: { turnOnSharing?: boolean }): Promise<GroupOperationResult<SettingDecisionResult>>;
  /** Take the group's value of a shared setting here. */
  accept(path: string, options?: { turnOnSharing?: boolean }): Promise<GroupOperationResult<SettingDecisionResult>>;
}

/**
 * Bind the operations to one context.
 *
 * The daemon route module, the TUI command and any web UI all take this object
 * and nothing else, which is what keeps them renderings rather than
 * reimplementations.
 */
export function createClusterGroupVerbs(context: GroupOperationsContext): ClusterGroupVerbSurface {
  return {
    status: () => groupStatus(context),
    create: (input) => createGroup(context, {
      ...(input.name !== undefined ? { displayName: input.name } : {}),
      ...(input.passphrase !== undefined ? { passphrase: input.passphrase } : {}),
    }),
    join: (input) => joinGroup(context, input),
    key: () => joinKeyForGroup(context),
    nodes: () => groupNodes(context),
    groups: () => groupsOnTheNetwork(context),
    forget: (nodeId, options) => forgetNode(context, nodeId, options),
    rotate: (input) => rotateGroupKey(context, input),
    leave: () => leaveGroup(context),
    rename: (name, options) => renameGroupTo(context, name, options),
    publish: (path, options) => decideLocalSetting(context, path, 'publish', options),
    accept: (path, options) => decideLocalSetting(context, path, 'accept', options),
  };
}

/**
 * config-replication.ts, the group's shared settings, on every machine that
 * might have to serve them.
 *
 * Leader election decides which machine reads an inbox. That is only half an
 * answer: a machine that wins a surface and does not hold the surface's
 * configuration, or its credential, cannot serve it, and the handover is
 * theatre. This closes that.
 *
 * ── shape ──────────────────────────────────────────────────────────────────
 *
 *   Every member issues revisions for the changes made on it and broadcasts
 *   them. The document is a per-path merge ordered by revision (config-replica.ts),
 *   so changes from any number of members combine the same way everywhere and
 *   no member has to be in charge.
 *
 *   A machine that joins asks for a SNAPSHOT; one member answers (the same one
 *   on every member, see `ConfigReplicationHost.answersFor`). From then on it
 *   receives DELTAS.
 *
 *   Copies are compared by content, not by counter: every roster gossip
 *   carries a digest of the sender's document, and a member whose digest
 *   differs sends its own document and asks for the sender's. That is what
 *   heals a missed datagram and a network split.
 *
 *   A change made here before this copy holds the group's settings is HELD and
 *   published once it does, so a machine that just joined cannot overwrite the
 *   group with what it had before joining, and the change is not lost either.
 *
 * Everything rides the group transport and the group keyring, the same signed,
 * group-scoped channel every other cluster datagram uses. There is no second
 * channel and no second trust boundary.
 *
 * ── authority ──────────────────────────────────────────────────────────────
 *
 * Each operation captures its authority once (`captureAuthority`) and checks
 * it after each wait and before each effect: a write to the store, a config or
 * secret change, a send. A new document is built as a local value and becomes
 * this copy's document only together with its persisted copy (`commit`), so an
 * operation abandoned part way leaves no revision that was neither saved nor sent.
 *
 * ── secrets ────────────────────────────────────────────────────────────────
 *
 * A credential never travels in the clear and never travels as another node's
 * ciphertext. It is sealed to each recipient's agreement key for the journey,
 * and the receiver hands the plaintext to its OWN secret store, which encrypts
 * it under its OWN keyfile at rest. Nothing here logs a value, and nothing here
 * puts one in `/status`, a replicated secret is reported as a path and a
 * revision, never as a value.
 */
import { CONFIG_SNAPSHOT_PART, CONFIG_BODY_LIMIT, ConfigSnapshotTransfers, prepareConfigSnapshotTransfer } from './config-snapshot-transfer.js';
import { GroupConfigChangeRetiredError } from './group-config-changes.js';
import { canonicalReplicatedSecretRef, ConfigReplicationPrivacyError, isSecretBearingConfigKey, localCredentialLiteral, publicCredentialPointer } from './config-replication-privacy.js';
import { openSealedEnvelope, sealForMember, type NodeKeyMaterial } from './group-crypto.js';
import {
  isReplicatedConfigPath,
  isReplicatedSecretKey,
  listReplicatedConfigPaths,
  replicatedSecretKeyFor,
} from './config-replication-policy.js';
import {
  appliedRevision,
  createConfigReplicaDocument,
  deleteReplicaEntry,
  findReplicaEntry,
  isReplicableValue,
  MAX_REVISION_ADVANCE,
  mergeConfigReplica,
  putReplicaEntry,
  readConfigReplicaDocument,
  replicaDigest,
  sweepConfigReplica,
  wireReplicaDocument,
  withApplied,
  readReplicaAct,
  withRecordedActsOnly,
  CARRIED_ACT,
  type ConfigReplicaDocument,
  type ConfigReplicaEntry,
  type ConfigReplicaTombstone,
  type ReplicaAct,
} from './config-replica.js';
import { MAX_GROUP_MEMBERS, type GroupStateDocument } from './group-state.js';
import type { ClusterEnvelope } from './protocol-envelope.js';
import type { ClusterLogger } from './types.js';

/** Message types this layer speaks. All group-key signed, like everything else. */
export const CONFIG_MESSAGE_TYPES = {
  snapshot: 'CONFIG_SNAPSHOT',
  snapshotPart: CONFIG_SNAPSHOT_PART,
  delta: 'CONFIG_DELTA',
  request: 'CONFIG_REQUEST',
} as const;

const SECRET_SEAL_CONTEXT = 'goodvibes-cluster-config-secret-v1';

function sameEffect(entry: { revision: number; origin: string; secret: boolean } | null | undefined, selected: { readonly revision: number; readonly origin: string; readonly secret: boolean }): boolean {
  return !!entry && entry.revision === selected.revision && entry.origin === selected.origin && entry.secret === selected.secret;
}
function selectedDeletion(document: ConfigReplicaDocument, path: string): ConfigReplicaTombstone | null {
  const deletion = document.tombstones.find(entry => entry.path === path), value = findReplicaEntry(document, path);
  return deletion && (!value || value.revision <= deletion.revision) ? deletion : null;
}

/** The narrow slice of config this layer touches. */
export interface ReplicatedConfigStore {
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  /**
   * Return a setting to its default. Optional: a store without it simply keeps
   * the local value after a group-wide delete, and the tombstone still stops
   * that value from being replicated back out.
   */
  reset?(path: string): void;
  /** Actual successful local edits, including file-watcher reloads. */
  subscribe?(path: string, listener: () => void): () => void;
  /**
   * Who made the write whose change notice is being delivered now, and how it was decided (ConfigManager `writeAct`),
   * read by a listener while it is called; undefined when the write stated none (an edit outside the daemon's controls).
   */
  writeAct?(): ReplicaAct | undefined;
}

/** The narrow slice of the secret store this layer touches. */
export interface ReplicatedSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  onDidChange?(listener: (key: string) => void): () => void;
  /** Who made the write whose notice is being delivered now, and how it was decided (`SecretsManager.writeAct`). */
  writeAct?(): ReplicaAct | undefined;
}

/** What the replication service borrows from the group runtime. */
export interface ConfigReplicationHost {
  readonly nodeId: string;
  readonly logger: ClusterLogger;
  now(): number;
  groupState(): GroupStateDocument | null;
  /**
   * True when this machine is the one that answers a settings request from
   * `asker` that names no machine. Every member reaches the same answer from
   * the roster, so one request gets one reply.
   */
  answersFor(asker: string): boolean;
  /**
   * Capture this operation's authority: the live membership, keys and stores.
   * The returned check throws once any of them changed; it compares captured
   * values only and does no I/O.
   */
  captureAuthority(envelope?: ClusterEnvelope): () => void;
  nodeKeys(): NodeKeyMaterial | null;
  config(): ReplicatedConfigStore | null;
  secrets(): ReplicatedSecretStore | null;
  /** Send an already-built group message. */
  send(type: string, body: Record<string, unknown>): Promise<void>;
  /** Persist the replica document alongside the roster. */
  persist(document: ConfigReplicaDocument): void;
  /**
   * Persist the changes made here that are held until this copy holds the
   * group's settings, so a restart before then does not lose them. Optional:
   * without it they are kept in memory only.
   */
  persistHeld?(groupId: string, held: readonly HeldConfigChange[]): void;
}

/** A change made on this machine, held until this copy holds the group's settings. */
export interface HeldConfigChange {
  readonly path: string;
  readonly kind: 'set' | 'secret' | 'delete';
  readonly secret: boolean;
  readonly applyLocal: boolean;
  /** Who made it and how it was decided (kept with it while it is held, sent with it after). */
  readonly act?: ReplicaAct | undefined;
}

/** Held changes read back from disk; anything malformed or outside the replication policy is dropped. */
export function readHeldConfigChanges(value: unknown): HeldConfigChange[] {
  if (!Array.isArray(value)) return [];
  const held: HeldConfigChange[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const path = record['path'], kind = record['kind'];
    if (typeof path !== 'string' || !isReplicatedConfigPath(path)) continue;
    if (kind !== 'set' && kind !== 'secret' && kind !== 'delete') continue;
    const act = readReplicaAct(record['act']);
    held.push({ path, kind, secret: record['secret'] === true, applyLocal: record['applyLocal'] === true, ...(act ? { act } : {}) });
  }
  return held;
}

/** A shared setting whose value here differs from the one another member wrote last, kept until the owner decides. */
export interface ConfigLocalDifference {
  readonly path: string;
  /** The member whose value the group holds. */
  readonly origin: string;
}

/** What `cluster status` reports about replication. Never a value. */
export interface ConfigReplicationStatus {
  readonly revision: number;
  readonly entries: number;
  readonly secrets: number;
  readonly tombstones: number;
  readonly lastAppliedFrom: string | null;
  readonly lastAppliedAt: number | null;
  /**
   * True while this copy is known to differ from another member's, or does
   * not yet hold the group's settings. The revision alone cannot show it: two
   * copies can report the same revision and hold different settings.
   */
  readonly awaitingSync: boolean;
  /** Credentials the group says exist but whose value has not arrived here. */
  readonly credentialsMissing: number;
  /** Changes from the group that this machine has not applied yet; retried every housekeeping pass. */
  readonly changesNotApplied: number;
  /** Changes made here that are held until this copy holds the group's settings, then published. */
  readonly localChangesHeld: number;
  /**
   * Shared settings whose value on this machine differs from the one another
   * member wrote last, and which nothing here announced (an edit made while the
   * daemon was stopped, or by a writer that does not announce). They are not
   * overwritten: `cluster publish <path>` sends this machine's value to the
   * group, `cluster accept <path>` takes the group's. Paths only, never a value.
   */
  readonly localDifferences: readonly ConfigLocalDifference[];
  /**
   * The latest shared settings changed on other machines, newest first, each with who made it there and how it was
   * decided (the record the change carried). Paths and who, never a value.
   */
  readonly recentFromGroup: readonly ConfigRecentChange[];
  /**
   * Members whose own changes were not taken here because they record no one who made them: `olderRelease` when that
   * member never recorded one (it runs an older release, such as 3.5.0: its changes cross once it is upgraded; this
   * machine's changes still reach it), else changes made there outside its settings controls.
   */
  readonly notTakenFrom: readonly { readonly machine: string; readonly olderRelease: boolean; readonly paths: number; readonly at: number }[];
  /** Members known to run an older release (their messages do not say they record who made a change), by name. */
  readonly olderReleaseMembers: readonly string[];
}

/** One shared setting changed on another machine, as this one keeps it (ConfigReplicationStatus `recentFromGroup`). */
export interface ConfigRecentChange {
  readonly path: string;
  /** The machine it was made on, by its name in the group (its id when the roster does not name it). */
  readonly machine: string;
  readonly deleted: boolean;
  readonly at: number;
  readonly act: ReplicaAct;
}

/** How a change was decided, in the owner's words: "his press", "his yes to <caller>", "<caller> under his rules". */
export function describeReplicaAct(act: ReplicaAct): string {
  const who = act.name ?? (act.owner ? 'you' : act.by);
  if (act.how === 'press') return act.owner ? 'you, with your own press' : `${who}, with a press`;
  if (act.how === 'yes') return `${who}, and you said yes to it`;
  if (act.how === 'carried') return 'you (carried from before this record existed)';
  return `${who}, allowed by your rules without asking`;
}

/** How often a machine that holds a credential marker without its value asks again. */
const SECRET_REREQUEST_MS = 60_000;
/** One content exchange with a given member at most this often, however often it gossips. */
const EXCHANGE_MIN_INTERVAL_MS = 10_000;

type HeldChange = Omit<HeldConfigChange, 'path'>;

export class ConfigReplicationService {
  private document: ConfigReplicaDocument;
  private digestOf: { readonly document: ConfigReplicaDocument; readonly digest: string } | null = null;
  private readonly snapshots = new ConfigSnapshotTransfers();
  private lastAppliedFrom: string | null = null;
  private lastAppliedAt: number | null = null;
  /** Highest revision known to exist while this copy is missing part of it; null when nothing is missing. */
  private resyncUntil: number | null = null;
  /** True once this copy has merged a member's full document, or matched one's digest, since it was adopted. */
  private synced = false;
  /** True while the copy in use is the one this machine kept in its records, before an exchange since the start. */
  private keptFromRecord = false;
  private readonly divergentPeers = new Set<string>();
  private readonly lastExchange = new Map<string, number>();
  private readonly held = new Map<string, HeldChange>();
  /** The release of held changes running now, shared by every caller until it settles. */
  private releasing: Promise<void> | null = null;
  private lastMissingSecretRequestAt: number | null = null;
  private readonly secretMutations = new Map<string, Promise<void>>();
  /** Per path, the member whose value differs from this machine's, and that entry's revision. */
  private readonly localDifferences = new Map<string, { readonly origin: string; readonly revision: number }>();

  constructor(private readonly host: ConfigReplicationHost, groupId: string) {
    this.document = createConfigReplicaDocument(groupId);
  }

  /**
   * Adopt a document read back from disk, or from a group this node just
   * joined. What is still to apply here is derived from the document and its
   * applied state (`pendingEffects`), so nothing that was saved is forgotten.
   */
  adopt(document: ConfigReplicaDocument, held: readonly HeldConfigChange[] = [], fromRecord = false): void {
    this.snapshots.clear();
    this.held.clear();
    this.resyncUntil = null; this.divergentPeers.clear(); this.lastExchange.clear();
    this.localDifferences.clear();
    this.synced = false;
    // The group's settings this machine kept in its records (read back at start): they are the group's settings here
    // until the next exchange replaces them, so nothing shared is missing between a restart and that exchange.
    // Changes made here are still held until that exchange (`inStep`), so none overwrites a newer group change.
    this.keptFromRecord = fromRecord && document.revision > 0;
    // A copy a release that did not record who made a change wrote (3.5.0), read by this release for the first time:
    // its upgrade. What it holds now is all the carry mark may ever apply to (`carryUnrecorded`), kept with it.
    const upgrading = document.carried !== true && document.carryThrough === undefined;
    this.document = this.publicDocument(upgrading ? { ...document, carryThrough: document.revision } : document);
    // Changes held before a restart are held again, for the same group only.
    for (const change of held) this.held.set(change.path, { kind: change.kind, secret: change.secret, applyLocal: change.applyLocal });
  }

  retireSnapshotTransfers(): void { this.snapshots.clear(); }

  get replica(): ConfigReplicaDocument {
    return this.document;
  }

  /** The fingerprint roster gossip carries; recomputed only when the document changes. */
  get digest(): string {
    if (this.digestOf?.document !== this.document) this.digestOf = { document: this.document, digest: replicaDigest(this.document) };
    return this.digestOf.digest;
  }

  /**
   * True when this copy may publish what this machine holds: it has the
   * group's settings, or it is the only member, so there is no group to
   * overwrite.
   */
  get inStep(): boolean {
    if (this.synced) return true;
    const members = this.host.groupState()?.members ?? [];
    // The only member holds the group's settings by definition, and still does once others join.
    if (members.length > 0 && members.every(member => member.nodeId === this.host.nodeId)) this.synced = true;
    return this.synced;
  }

  status(): ConfigReplicationStatus {
    return {
      revision: this.document.revision,
      entries: this.document.entries.filter((entry) => !entry.secret).length,
      secrets: this.document.entries.filter((entry) => entry.secret).length,
      tombstones: this.document.tombstones.length,
      lastAppliedFrom: this.lastAppliedFrom,
      lastAppliedAt: this.lastAppliedAt,
      // A member known to run an older release differs by design until it is updated: said as that (`olderReleaseMembers`), not as out of step.
      awaitingSync: !(this.inStep || this.keptFromRecord) || this.resyncUntil !== null || [...this.divergentPeers].some((peer) => !this.olderPeers.has(peer)),
      olderReleaseMembers: [...this.olderPeers.keys()].filter((nodeId) => (this.host.groupState()?.members ?? []).some((member) => member.nodeId === nodeId))
        .map((nodeId) => (this.host.groupState()?.members ?? []).find((member) => member.nodeId === nodeId)?.displayName ?? nodeId),
      credentialsMissing: this.missingCredentials().length,
      changesNotApplied: (() => { const pending = this.pendingEffects(); return pending.sets.length + pending.deletes.length; })(),
      localChangesHeld: this.held.size,
      localDifferences: [...this.localDifferences].map(([path, difference]) => ({ path, origin: difference.origin })),
      recentFromGroup: this.recentFromGroup(),
      notTakenFrom: [...this.unrecordedFrom].map(([nodeId, kept]) => ({
        machine: (this.host.groupState()?.members ?? []).find((member) => member.nodeId === nodeId)?.displayName ?? nodeId,
        olderRelease: !this.peersRecordingActs.has(nodeId), paths: kept.paths.size, at: kept.at,
      })),
    };
  }

  /** The latest shared settings changed on other machines with who made each there (ConfigReplicationStatus). */
  private recentFromGroup(limit = 5): readonly ConfigRecentChange[] {
    const names = new Map((this.host.groupState()?.members ?? []).map((member) => [member.nodeId, member.displayName] as const));
    const changes: ConfigRecentChange[] = [];
    for (const entry of this.document.entries) {
      if (entry.origin === this.host.nodeId || !entry.act) continue;
      changes.push({ path: entry.path, machine: names.get(entry.origin) ?? entry.origin, deleted: false, at: entry.at, act: entry.act });
    }
    for (const tombstone of this.document.tombstones) {
      if (tombstone.origin === this.host.nodeId || !tombstone.act) continue;
      changes.push({ path: tombstone.path, machine: names.get(tombstone.origin) ?? tombstone.origin, deleted: true, at: tombstone.at, act: tombstone.act });
    }
    return changes.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /**
   * The shared settings that differ here, each with this machine's value and the group's, for the owner choosing one
   * to share or take. Only settings that hold no secret are ever listed (a local difference never is one).
   */
  localDifferenceValues(): readonly { readonly path: string; readonly origin: string; readonly here: unknown; readonly group: unknown }[] {
    const config = this.host.config();
    return [...this.localDifferences].filter(([path]) => !isSecretBearingConfigKey(path)).map(([path, difference]) => ({
      path, origin: difference.origin, here: config?.get(path), group: findReplicaEntry(this.document, path)?.value,
    }));
  }

  private publicDocument(document: ConfigReplicaDocument): ConfigReplicaDocument {
    const entries = document.entries.filter(entry => {
      if (entry.secret) {
        const marker = entry.value;
        if (marker && typeof marker === 'object' && !Array.isArray(marker) && Object.keys(marker).length === 1
          && 'secretRevision' in marker && Number.isSafeInteger(marker.secretRevision) && (marker.secretRevision as number) >= 0) return true;
      } else if (!isSecretBearingConfigKey(entry.path) || publicCredentialPointer(entry.path, entry.value)) return true;
      this.host.logger.warn('cluster: refused public credential configuration; use the encrypted credential setting', { path: entry.path }); return false;
    });
    return entries.length === document.entries.length ? document : { ...document, entries };
  }
  private credentialLiteral(path: string, value: unknown): string | null {
    try { return localCredentialLiteral(path, value); }
    catch (error) { this.host.logger.warn('cluster: credential reference is local-only; use the encrypted credential setting for group sharing', { path }); throw error; }
  }

  /**
   * Group changes not yet applied on this machine: every entry and selected
   * deletion above the revision recorded as applied for its path. Derived from
   * the saved document every time, never kept in a second copy, so a restart
   * between saving a change and applying it loses nothing.
   */
  private pendingEffects(): { readonly sets: readonly ConfigReplicaEntry[]; readonly deletes: readonly ConfigReplicaTombstone[] } {
    const sets: ConfigReplicaEntry[] = [], deletes: ConfigReplicaTombstone[] = [];
    for (const entry of this.document.entries) {
      if (entry.secret || this.held.has(entry.path)) continue;
      if (appliedRevision(this.document, entry.path) < entry.revision) sets.push(entry);
    }
    for (const tombstone of this.document.tombstones) {
      if (this.held.has(tombstone.path) || selectedDeletion(this.document, tombstone.path) !== tombstone) continue;
      if (appliedRevision(this.document, tombstone.path) < tombstone.revision) deletes.push(tombstone);
    }
    return { sets, deletes };
  }

  /** Credentials the group says exist whose value for the CURRENT revision is not stored here. */
  private missingCredentials(): readonly string[] {
    return this.document.entries.filter((entry) => entry.secret && !this.held.has(entry.path)
      && appliedRevision(this.document, entry.path) !== entry.revision).map((entry) => entry.path);
  }

  /** The one place this copy's document changes: saved first, then held. */
  private commit(next: ConfigReplicaDocument, check: () => void): void {
    check();
    this.host.persist(next);
    this.document = next;
  }

  private async effectiveSecret(path: string, check: () => void): Promise<string | null> {
    const config = this.host.config(), classified = isSecretBearingConfigKey(path), configured = classified ? config?.get(path) : undefined;
    const literal = classified ? this.credentialLiteral(path, configured) : null;
    const value = literal ?? await this.host.secrets()?.get(replicatedSecretKeyFor(path)) ?? null;
    check(); if (classified && config?.get(path) !== configured) throw new ConfigReplicationPrivacyError();
    return value;
  }

  // ── reconciling this machine's own config into the replica ────────────────

  /**
   * Fold local changes into the replica, and broadcast them.
   *
   * A reconcile rather than a change hook, so it catches an edit made through
   * any path at all, including one made while this process was not running.
   * It never publishes over another machine's change, and never silently
   * overwrites this machine's: a local value that differs from a setting
   * another member wrote last is applied from the group only when this machine
   * is known to have matched an older revision of it (a group change not yet
   * applied here). Otherwise it is an edit made here that nothing announced,
   * and it is kept and reported as a local difference until the owner
   * publishes it or accepts the group's value.
   */
  /** Members that sent a change of their own recording who made it: they run a release that keeps the record. */
  private readonly peersRecordingActs = new Set<string>();
  /** Members known to run an older release: their config messages do not say `actsRecorded`. */
  private readonly olderPeers = new Map<string, true>();
  /**
   * Older-release members already asked for their copy once, with the membership generation they had then: such a
   * member's copy differs by design, so it is not asked again on every pass; asked again when its release changes
   * (`handle`) or it rejoins (a new generation on the roster).
   */
  private readonly askedOlder = new Map<string, number>();
  /** Per member, its own changes not taken here because they record no one who made them (paths only). */
  private readonly unrecordedFrom = new Map<string, { paths: Set<string>; at: number }>();

  /**
   * A member's own changes that record no one who made them were not taken. Said once per member and path, in the log
   * and in the status: either it runs an older release of GoodVibes (one that never records who made a change, such as
   * 3.5.0), whose changes do not cross to this machine until it is upgraded while this machine's still reach it; or the
   * change was made there outside its settings controls.
   */
  /**
   * Paths the group holds a change for that was not taken here (it records no one): this machine's own value of such a
   * path is never folded in as the group's (`reconcileLocalConfig`), so a refused change is never overwritten by it.
   */
  private readonly refusedPaths = new Set<string>();

  private noteUnrecorded(from: string, changes: readonly { readonly path: string; readonly revision: number; readonly origin: string }[]): void {
    for (const change of changes) this.refusedPaths.add(change.path);
    // A change this copy already holds (the same path, revision and origin) is not missing here, only its record is:
    // a machine put back to 3.5.0 writes its copy back without it.
    const held = (change: { readonly path: string; readonly revision: number; readonly origin: string }): boolean =>
      [...this.document.entries, ...this.document.tombstones].some((own) => own.path === change.path && own.revision === change.revision && own.origin === change.origin);
    const paths = changes.filter((change) => !held(change)).map((change) => change.path);
    if (paths.length === 0) return;
    const kept = this.unrecordedFrom.get(from) ?? { paths: new Set<string>(), at: 0 };
    const fresh = paths.filter((path) => !kept.paths.has(path));
    for (const path of paths) kept.paths.add(path);
    kept.at = this.host.now();
    this.unrecordedFrom.set(from, kept);
    if (fresh.length === 0) return;
    const machine = (this.host.groupState()?.members ?? []).find((member) => member.nodeId === from)?.displayName ?? from;
    this.host.logger.warn(this.peersRecordingActs.has(from)
      ? `cluster: changes made on ${machine} outside its settings controls record no one who made them, so this machine did not take them`
      : `cluster: ${machine} runs an older release of GoodVibes that does not record who made a change, so its setting and credential changes do not cross to this machine until it is upgraded; changes made here still reach it`,
    { path: fresh.slice(0, 8).join(', ') + (fresh.length > 8 ? ` and ${fresh.length - 8} more` : '') });
  }

  /** A member's change of these paths was taken with its record: what was said not taken for them is no longer so. */
  private noteRecorded(from: string, paths: readonly string[]): void {
    const kept = this.unrecordedFrom.get(from);
    if (!kept) return;
    for (const path of paths) kept.paths.delete(path);
    if (kept.paths.size === 0) this.unrecordedFrom.delete(from);
  }

  /** The owner's act that started or joined the group here: the settings in force become the group's under it. */
  private seedAct: ReplicaAct | undefined;
  /** The same act, kept while this process runs: a credential held here that the group has no record of is seeded under it. */
  private startAct: ReplicaAct | undefined;

  /** When a 3.5.0 daemon put back on this machine last wrote the group's settings since the upgrade (group-runtime option). */
  private olderReleaseRanAt: number | undefined;

  /** Note that 3.5.0 ran on this machine since the upgrade: its own changes from that run are marked the owner's once. */
  noteOlderReleaseRun(at: number | undefined): void {
    this.olderReleaseRanAt = at;
  }

  /** Record the act that started or joined the group on this machine (its next reconcile seeds the group's settings under it). */
  seedWith(act: ReplicaAct | undefined): void {
    this.seedAct = act;
    this.startAct = act;
  }

  async reconcileLocalConfig(): Promise<void> {
    const check = this.host.captureAuthority();
    const config = this.host.config();
    if (!config || !this.inStep) return;
    let next = this.document;
    const changed: string[] = [];
    const agreed: Record<string, number> = {};
    // A run of 3.5.0 put back on this machine since the upgrade that this record has not taken in yet.
    const olderRun = this.olderReleaseRanAt !== undefined && (this.document.olderReleaseRun ?? 0) < this.olderReleaseRanAt ? this.olderReleaseRanAt : undefined;
    const deleted = new Set(next.tombstones.map((entry) => entry.path));
    const pending = this.pendingEffects();
    const unapplied = new Set([...pending.sets.map((entry) => entry.path), ...pending.deletes.map((entry) => entry.path)]);
    for (const path of listReplicatedConfigPaths()) {
      // A path the group DELETED is never picked back up by a reconcile: a
      // local value can outlive the deletion, and folding it in again would
      // undo the operator's deletion. Re-adding is an explicit act:
      // `announceLocalChange` clears the tombstone. A group change not yet
      // applied here is applied by `applyPendingEffects`, not folded back.
      if (deleted.has(path) || isSecretBearingConfigKey(path) || unapplied.has(path) || this.held.has(path)) continue;
      const value = config.get(path);
      if (!isReplicableValue(value)) continue;
      const entry = findReplicaEntry(next, path);
      if (entry && JSON.stringify(entry.value) === JSON.stringify(value)) {
        if (appliedRevision(next, path) !== entry.revision) agreed[path] = entry.revision;
        this.localDifferences.delete(path);
        continue;
      }
      if (entry && entry.origin !== this.host.nodeId) {
        // Applied here and changed since: an edit made here that nothing announced.
        if (this.localDifferences.get(path)?.revision !== entry.revision) {
          this.localDifferences.set(path, { origin: entry.origin, revision: entry.revision });
          this.host.logger.warn('cluster: this machine\'s value for a shared setting differs from the group\'s and was kept; in Devices and network, Machine group, "share a setting" sends this machine\'s value to the group and "take the group\'s setting" takes the group\'s', { path, origin: entry.origin });
        }
        continue;
      }
      // A path the group has no entry for yet takes this machine's value as the group's when the owner started or
      // joined the group here: that act is what made it the group's (`seedWith`). Any other is an edit nothing
      // announced, recorded with no one who made it, which the other machines do not take.
      // A path the group holds a change for that was not taken here is not folded in: that would overwrite it.
      if (entry === null && this.refusedPaths.has(path)) continue;
      // This machine's own change made while it ran 3.5.0 after the upgrade (it is in its settings, not in this
      // record) records no one: the carry mark applies once, to what this machine held at its own upgrade, never to a
      // change made after it (gate-review-6 G14). It stays here until the owner shares it ("share a setting").
      const act = entry === null ? this.seedAct : undefined;
      if (!act) this.host.logger.warn(olderRun !== undefined
        ? 'cluster: a shared setting changed here while this machine ran an older release records no one who made it, so the other machines will not take it; in Devices and network, Machine group, "share a setting" sends it as your own'
        : 'cluster: a shared setting changed here records no one who made it (it was not changed through the daemon\'s settings controls), so the other machines will not take it', { path });
      next = putReplicaEntry(next, { path, value, origin: this.host.nodeId, at: this.host.now(), ...(act ? { act } : {}) });
      changed.push(path);
      agreed[path] = next.revision;
    }
    if (olderRun !== undefined) next = { ...next, olderReleaseRun: olderRun };
    if (changed.length === 0 && Object.keys(agreed).length === 0 && olderRun === undefined) return;
    // One write for the batch: the new entries and the applied state together.
    this.commit(withApplied(next, agreed), check);
    if (changed.length > 0) this.seedAct = undefined;
    for (const path of changed) this.localDifferences.delete(path);
    if (changed.length > 0) await this.broadcastDelta(this.document, changed, check);
  }

  /** This machine's value is the replica's for `path` now: recorded as applied in the same write. */
  private appliedHere(document: ConfigReplicaDocument, path: string): ConfigReplicaDocument {
    this.localDifferences.delete(path);
    const entry = findReplicaEntry(document, path);
    const deletion = selectedDeletion(document, path);
    const revision = deletion?.revision ?? entry?.revision;
    return revision === undefined ? document : withApplied(document, { [path]: revision });
  }

  /**
   * The owner's answer to a local difference: send this machine's value to the
   * group. Refused for a path that is not shared or holds a credential (those
   * have their own commands).
   */
  async publishLocalValue(path: string, act?: ReplicaAct): Promise<'published' | 'held'> {
    if (!isReplicatedConfigPath(path) || isSecretBearingConfigKey(path)) throw new ConfigLocalDifferenceError(path, 'is not a shared setting this command publishes');
    // Before this copy holds the group's settings the change is held, then sent.
    const held = !this.inStep;
    await this.announceLocalChange(path, undefined, act);
    return held ? 'held' : 'published';
  }

  /** The owner's other answer: take the group's value for `path` here. */
  async acceptGroupValue(path: string): Promise<void> {
    if (!isReplicatedConfigPath(path) || isSecretBearingConfigKey(path)) throw new ConfigLocalDifferenceError(path, 'is not a shared setting this command can take from the group');
    const config = this.host.config();
    const entry = findReplicaEntry(this.document, path);
    if (!config) throw new ConfigLocalDifferenceError(path, 'cannot be changed here: this machine has no settings store for the group');
    if (!entry || entry.secret) throw new ConfigLocalDifferenceError(path, 'has no value in the group\'s settings to take');
    const check = this.host.captureAuthority();
    check();
    if (JSON.stringify(config.get(path)) !== JSON.stringify(entry.value)) config.set(path, entry.value);
    this.commit(this.appliedHere(this.document, path), check);
    this.logApplied(path, entry.origin, false);
  }

  /**
   * Record an operator edit made on this machine and send it to the group.
   *
   * Writes the path EXPLICITLY rather than going through the reconcile,
   * because the reconcile deliberately skips anything the group has deleted.
   * Setting a deleted path again is the operator undoing the deletion, and this
   * is the only path that can.
   */
  async announceLocalChange(path: string, observed?: () => void, act?: ReplicaAct): Promise<void> {
    if (!isReplicatedConfigPath(path)) return;
    const authority = this.host.captureAuthority();
    const check = observed ? () => { observed(); authority(); } : authority;
    const config = this.host.config();
    if (isSecretBearingConfigKey(path)) {
      // An emptied credential setting is the deletion, already made here.
      if (config?.get(path) !== '') await this.announceLocalSecret(path, check, false, act);
      else if (!this.inStep) this.hold(path, { kind: 'delete', secret: true, applyLocal: false, ...(act ? { act } : {}) });
      else await this.publishDelete(path, true, check, false, act);
      return;
    }
    const value = config?.get(path);
    if (!isReplicableValue(value)) return;
    if (!this.inStep) { this.hold(path, { kind: 'set', secret: false, applyLocal: false, ...(act ? { act } : {}) }); return; }
    // A change with no recorded actor (an edit outside the daemon's settings controls) is not taken by the others.
    if (!act) this.host.logger.warn('cluster: a shared setting changed here records no one who made it (it was not changed through the daemon\'s settings controls), so the other machines will not take it', { path });
    const next = this.appliedHere(putReplicaEntry(this.document, { path, value, origin: this.host.nodeId, at: this.host.now(), ...(act ? { act } : {}) }), path);
    this.commit(next, check);
    await this.broadcastDelta(next, [path], check);
  }

  /** Replicate a secret the operator set on this machine. A seed publishes only a credential the group has no record of. */
  async announceLocalSecret(configPath: string, observed?: () => void, seed = false, act?: ReplicaAct): Promise<void> {
    if (!isReplicatedConfigPath(configPath)) return;
    const authority = this.host.captureAuthority(), config = this.host.config();
    const classified = isSecretBearingConfigKey(configPath), configured = classified ? config?.get(configPath) : undefined;
    const check = () => { observed?.(); authority(); if (classified && config?.get(configPath) !== configured) throw new ConfigReplicationPrivacyError(); };
    const secrets = this.host.secrets();
    if (!secrets) return;
    if (seed && (!this.inStep || findReplicaEntry(this.document, configPath) || this.document.tombstones.some(entry => entry.path === configPath))) return;
    if (!this.inStep) { this.hold(configPath, { kind: 'secret', secret: true, applyLocal: false, ...(act ? { act } : {}) }); return; }
    const literal = classified ? this.credentialLiteral(configPath, configured) : null;
    const value = literal ?? await secrets.get(replicatedSecretKeyFor(configPath));
    check();
    if (value === null) { if (!seed) await this.publishDelete(configPath, true, check, false, act); return; }
    // A seed is the group's first record of a credential held here when the owner started or joined it (`seedWith`).
    const recorded = act ?? (seed ? this.seedAct ?? this.startAct : undefined);
    if (!recorded) this.host.logger.warn('cluster: a credential changed here records no one who made it (it was not changed through the daemon\'s settings controls), so the other machines will not take it', { path: configPath });
    await this.publishSecret(configPath, value, check, recorded);
  }

  /** Delete a setting across the group. */
  async announceLocalDelete(path: string, secret = false, observed?: () => void, act?: ReplicaAct): Promise<void> {
    if (!isReplicatedConfigPath(path)) return;
    const authority = this.host.captureAuthority();
    const check = observed ? () => { observed(); authority(); } : authority;
    if (!this.inStep) { this.hold(path, { kind: 'delete', secret, applyLocal: true, ...(act ? { act } : {}) }); return; }
    await this.publishDelete(path, secret, check, true, act);
  }

  private hold(path: string, change: HeldChange): void {
    this.held.set(path, change);
    this.persistHeld();
    this.host.logger.info('cluster: a shared setting changed here is held until this machine has the group\'s settings, then sent', { path });
  }

  /** Saves the held changes so a restart before this copy is in step does not lose them. */
  private persistHeld(): void {
    if (!this.host.persistHeld || !this.document.groupId) return;
    try {
      this.host.persistHeld(this.document.groupId, [...this.held].map(([path, change]) => ({ path, ...change })));
    } catch (error) {
      this.host.logger.warn('cluster: changes held for the group could not be saved; they are kept in memory and sent once this machine has the group\'s settings', {
        held: this.held.size,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Publish what was held, once this copy holds the group's settings. Each goes
   * out at a revision above everything merged. A change stays held until its own
   * publish succeeded, so a group value applied meanwhile never overwrites it;
   * one release runs at a time, and a second caller shares the one running.
   */
  private releaseHeld(): Promise<void> {
    if (this.releasing) return this.releasing;
    if (this.held.size === 0 || !this.inStep) return Promise.resolve();
    const run = this.releaseHeldOnce().finally(() => { if (this.releasing === run) this.releasing = null; });
    this.releasing = run;
    return run;
  }

  private async releaseHeldOnce(): Promise<void> {
    for (const [path, change] of [...this.held]) {
      try {
        if (change.kind === 'delete') await this.publishDelete(path, change.secret, this.host.captureAuthority(), change.applyLocal, change.act);
        else if (change.kind === 'secret') await this.announceLocalSecret(path, undefined, false, change.act);
        else await this.announceLocalChange(path, undefined, change.act);
      } catch (error) {
        // It, and the ones after it, are still held for the next pass.
        this.persistHeld();
        this.host.logger.debug('cluster: a held setting change could not be sent yet', { path, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // A newer hold of the same path made while this one was sent stays held.
      if (this.held.get(path) === change) this.held.delete(path);
    }
    this.persistHeld();
  }

  private async publishDelete(path: string, secret: boolean, check: () => void, applyLocal: boolean, act?: ReplicaAct): Promise<void> {
    // Clear it here too, where the store can. A deletion the operator made on
    // the group should not leave this machine still running the old value.
    if (applyLocal) {
      check(); this.host.config()?.reset?.(path);
      const secrets = this.host.secrets();
      if (secret && secrets) await this.mutateSecret(path, check, () => secrets.delete(replicatedSecretKeyFor(path)));
    }
    const at = this.host.now();
    // Made here (applyLocal) or already the state here (an emptied credential):
    // recorded as applied in the same write as the deletion.
    const next = this.appliedHere(deleteReplicaEntry(this.document, { path, origin: this.host.nodeId, at, secret, ...(act ? { act } : {}) }), path);
    this.commit(next, check);
    await this.send(check, CONFIG_MESSAGE_TYPES.delta, {
      deletes: [{ path, revision: next.revision, origin: this.host.nodeId, at, secret, ...(act ? { act } : {}) }],
    });
  }

  /** Serialize entered writes/deletes for one actual credential. Queue only
   * encrypted input/guards or callbacks, never decrypted credential caches.
   */
  private mutateSecret(path: string, check: () => void, effect: () => Promise<void>): Promise<void> {
    const previous = this.secretMutations.get(path) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => { check(); await effect(); check(); });
    this.secretMutations.set(path, task);
    const drained = () => { if (this.secretMutations.get(path) === task) this.secretMutations.delete(path); };
    void task.then(drained, drained); return task;
  }

  // ── sending ───────────────────────────────────────────────────────────────

  private async send(check: () => void, type: string, body: Record<string, unknown>): Promise<void> {
    check();
    // Says this machine records who made each change (a release older than this one, such as 3.5.0, never sends it
    // and ignores it), so a member tells an older release from a change made outside the settings controls.
    // A snapshot part's body is read field for field (config-snapshot-transfer.ts, by 3.5.0 too): it goes as it is.
    await this.host.send(type, type === CONFIG_MESSAGE_TYPES.snapshotPart ? body : { ...body, actsRecorded: true });
  }

  private async broadcastDelta(document: ConfigReplicaDocument, paths: readonly string[], check: () => void): Promise<void> {
    const entries = document.entries.filter((entry) => paths.includes(entry.path) && !entry.secret);
    if (entries.length === 0) return;
    const body = { entries };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= CONFIG_BODY_LIMIT) await this.send(check, CONFIG_MESSAGE_TYPES.delta, body);
    else await this.sendSnapshot(check);
  }

  private async sendSnapshot(check: () => void): Promise<void> {
    // The serialized image is fixed before anything is sent. A later revision
    // does not revoke this older signed image; receivers merge it per entry.
    const document = wireReplicaDocument(this.document);
    const body = { document };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= CONFIG_BODY_LIMIT) {
      await this.send(check, CONFIG_MESSAGE_TYPES.snapshot, body);
      return;
    }
    for (const part of prepareConfigSnapshotTransfer(document, document.revision)) {
      await this.send(check, CONFIG_MESSAGE_TYPES.snapshotPart, { ...part });
    }
  }

  /**
   * Record a secret in the replica and send it, sealed per member.
   *
   * The document holds only the fact that the path has a secret at a revision.
   * The value itself never lands in the document, so it is never written to the
   * replica file and never appears in a snapshot that is not individually
   * sealed.
   */
  private async publishSecret(configPath: string, value: string, check: () => void, act?: ReplicaAct): Promise<void> {
    // The value is in this machine's store already: applied under the new revision.
    const next = this.appliedHere(putReplicaEntry(this.document, {
      path: configPath,
      value: { secretRevision: this.document.revision + 1 },
      origin: this.host.nodeId,
      at: this.host.now(),
      secret: true,
      ...(act ? { act } : {}),
    }), configPath);
    this.commit(next, check);
    const entry = findReplicaEntry(next, configPath);
    if (!entry) return;
    await this.sendSealed(entry, value, check);
  }

  /**
   * Seal `value` to every current member and send it: one envelope when every
   * sealed copy fits, otherwise one envelope per member (the shape a joining
   * member already receives), so a long credential in a large group still
   * reaches everyone.
   */
  private async sendSealed(entry: ConfigReplicaEntry, value: string, check: () => void): Promise<void> {
    const members = this.host.groupState()?.members ?? [];
    const sealed: Record<string, unknown> = {};
    for (const member of members) {
      if (member.nodeId === this.host.nodeId) continue;
      sealed[member.nodeId] = sealForMember(member.agreementKey, value, SECRET_SEAL_CONTEXT);
    }
    const recipients = Object.keys(sealed);
    if (recipients.length === 0) return;
    // Who made it and how it was decided travels with the sealed value (a member takes none without it).
    const header = { secretPath: entry.path, origin: entry.origin, revision: entry.revision, ...(entry.act ? { act: entry.act } : {}) };
    const body = { ...header, sealed };
    if (recipients.length === 1 || Buffer.byteLength(JSON.stringify(body), 'utf8') <= CONFIG_BODY_LIMIT) {
      await this.send(check, CONFIG_MESSAGE_TYPES.delta, body);
      return;
    }
    const failed: string[] = [];
    for (const nodeId of recipients) {
      // One member that cannot be reached must not stop the ones after it.
      try {
        await this.send(check, CONFIG_MESSAGE_TYPES.delta, { ...header, sealed: { [nodeId]: sealed[nodeId] } });
      } catch (error) {
        check();
        failed.push(nodeId);
        this.host.logger.warn('cluster: a credential could not be sent to a member', { path: entry.path, to: nodeId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (failed.length > 0) {
      throw new Error(`The credential at ${entry.path} was not sent to ${failed.length} of ${recipients.length} members (${failed.join(', ')}). It is stored on this machine; set it again to resend it.`);
    }
  }

  /**
   * Ask for the group's settings. Addressed to `to` when one member is known
   * to hold what is missing; otherwise the member `answersFor` names replies.
   */
  async requestSnapshot(to?: string): Promise<void> {
    const check = this.host.captureAuthority();
    this.lastMissingSecretRequestAt = this.host.now();
    await this.send(check, CONFIG_MESSAGE_TYPES.request, to !== undefined && to !== this.host.nodeId ? { to } : {});
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  /** Route a config-replication datagram that already verified under the group key. */
  async handle(envelope: ClusterEnvelope): Promise<void> {
    if (envelope.nodeId === this.host.nodeId) return;
    // What the member runs now: a machine put back to an older release stops saying it (a snapshot part never says it).
    if (envelope.type !== CONFIG_MESSAGE_TYPES.snapshotPart) {
      const older = envelope.body['actsRecorded'] !== true;
      // Its release changed: it is asked for its copy again (`notePeerReplica`).
      if (older !== this.olderPeers.has(envelope.nodeId)) this.askedOlder.delete(envelope.nodeId);
      if (older) { this.peersRecordingActs.delete(envelope.nodeId); this.olderPeers.set(envelope.nodeId, true); }
      else { this.peersRecordingActs.add(envelope.nodeId); this.olderPeers.delete(envelope.nodeId); }
    }
    const check = this.host.captureAuthority(envelope);
    switch (envelope.type) {
      case CONFIG_MESSAGE_TYPES.request: return this.onRequest(envelope, check);
      case CONFIG_MESSAGE_TYPES.snapshotPart: return this.onSnapshotPart(envelope, check);
      case CONFIG_MESSAGE_TYPES.snapshot: return this.onSnapshot(envelope, check);
      case CONFIG_MESSAGE_TYPES.delta: return this.onDelta(envelope, check);
      default:
    }
  }

  private async onRequest(envelope: ClusterEnvelope, check: () => void): Promise<void> {
    const to = envelope.body['to'];
    if (to !== undefined ? to !== this.host.nodeId : !this.host.answersFor(envelope.nodeId)) return;
    await this.sendSnapshot(check);
    // Secrets are not in the document, so each one is sent sealed to the asker.
    const secrets = this.host.secrets();
    const member = this.host.groupState()?.members.find((entry) => entry.nodeId === envelope.nodeId);
    if (!secrets || !member) return;
    for (const entry of this.document.entries.filter((candidate) => candidate.secret)) {
      // Only a value stored here under the entry's own revision is that
      // revision's value: one stored under an older revision is not sent at
      // all (the asker would take it as the newer one), and the path stays
      // missing everywhere until the newer value arrives.
      if (appliedRevision(this.document, entry.path) !== entry.revision) continue;
      // One credential that cannot be sent must not stop the ones after it.
      try {
        const value = await this.effectiveSecret(entry.path, check);
        // Replaced meanwhile: the newer marker's own delta carried its value.
        if (value === null || findReplicaEntry(this.document, entry.path) !== entry) continue;
        await this.send(check, CONFIG_MESSAGE_TYPES.delta, {
          secretPath: entry.path,
          origin: entry.origin,
          revision: entry.revision,
          ...(entry.act ? { act: entry.act } : {}),
          sealed: { [member.nodeId]: sealForMember(member.agreementKey, value, SECRET_SEAL_CONTEXT) },
        });
      } catch (error) {
        // Losing authority (membership changed, shutdown) still ends the whole pass.
        check();
        this.host.logger.warn('cluster: a credential could not be sent to a joining machine and was skipped', { path: entry.path, to: member.nodeId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async onSnapshotPart(envelope: ClusterEnvelope, check: () => void): Promise<void> {
    const complete = this.snapshots.accept(envelope, this.host.now(), check);
    if (!complete) return;
    const current = () => { complete.assertCurrent(); check(); };
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(complete.bytes)); } catch { return; }
    const incoming = readConfigReplicaDocument(value, isReplicatedConfigPath);
    if (!incoming || incoming.groupId !== this.document.groupId || incoming.revision !== complete.revision) return;
    await this.applySnapshot(incoming, envelope.nodeId, current);
  }

  private async onSnapshot(envelope: ClusterEnvelope, check: () => void): Promise<void> {
    const incoming = readConfigReplicaDocument(envelope.body['document'], isReplicatedConfigPath);
    if (!incoming) {
      this.host.logger.debug('cluster: a config snapshot did not parse and was ignored', { from: envelope.nodeId });
      return;
    }
    await this.applySnapshot(incoming, envelope.nodeId, check);
  }

  private async applySnapshot(received: ConfigReplicaDocument, from: string, check: () => void): Promise<void> {
    if (!this.withinRevisionBound(received.revision, from)) return;
    // A setting change that records no one who made it is not taken from another machine.
    const { document: incoming, dropped } = withRecordedActsOnly(received);
    // Only the sender's own changes say anything about the sender (it relays others' as it holds them).
    const ownUnrecorded = [...received.entries, ...received.tombstones].filter((change) => !change.act && change.origin === from);
    // A full document says everything the sender holds: what it no longer holds unrecorded is no longer said.
    const stillUnrecorded = new Set(ownUnrecorded.map((change) => change.path));
    this.noteRecorded(from, [...(this.unrecordedFrom.get(from)?.paths ?? [])].filter((path) => !stillUnrecorded.has(path)));
    if (ownUnrecorded.length > 0) this.noteUnrecorded(from, ownUnrecorded);
    else if (dropped > 0) this.host.logger.debug('cluster: changes relayed by another machine that record no one who made them were not taken', { from, dropped });
    for (const change of [...received.entries, ...received.tombstones]) if (!change.act) this.refusedPaths.add(change.path);
    await this.applyDocument(mergeConfigReplica(this.document, this.publicDocument(incoming)), from, check);
    // A full document from a member: this copy now holds at least what it held.
    if (this.resyncUntil !== null && incoming.revision >= this.resyncUntil) this.resyncUntil = null;
    this.divergentPeers.delete(from);
    this.synced = true;
    await this.releaseHeld();
  }

  /** A document claiming a revision far beyond this copy's own is not applied. */
  private withinRevisionBound(revision: number, from: string): boolean {
    if (revision <= this.document.revision + MAX_REVISION_ADVANCE) return true;
    this.host.logger.warn('cluster: ignored replicated settings claiming an implausible revision', { from, revision, local: this.document.revision });
    return false;
  }

  /**
   * Every member issues the next revision above the highest it has seen, so a
   * change that starts more than one past this copy's revision was issued by a
   * member that saw something this copy never received. Merging raises the
   * counter to the newest value seen, which would hide that, so it is noted
   * first.
   */
  private noteGap(before: number, incoming: ConfigReplicaDocument): boolean {
    // A copy with nothing yet is already asking for everything (`needsSnapshot`).
    if (before === 0) return false;
    const revisions = [...incoming.entries.map((entry) => entry.revision), ...incoming.tombstones.map((entry) => entry.revision)];
    if (revisions.length === 0 || Math.min(...revisions) <= before + 1) return false;
    this.resyncUntil = Math.max(this.resyncUntil ?? 0, ...revisions);
    return true;
  }

  private async onDelta(envelope: ClusterEnvelope, check: () => void): Promise<void> {
    if (typeof envelope.body['secretPath'] === 'string') {
      await this.applySealedSecret(envelope, check);
      return;
    }
    const incoming = readConfigReplicaDocument(
      {
        version: 1,
        groupId: this.document.groupId,
        revision: this.document.revision,
        entries: envelope.body['entries'] ?? [],
        tombstones: envelope.body['deletes'] ?? [],
      },
      isReplicatedConfigPath,
    );
    if (!incoming) return;
    // A delta carries the sender's own changes; one naming another node as the
    // author is not something the sender can vouch for.
    const before = this.document.revision;
    const originated = { ...incoming, revision: before,
      entries: incoming.entries.filter((entry) => entry.origin === envelope.nodeId),
      tombstones: incoming.tombstones.filter((entry) => entry.origin === envelope.nodeId) };
    if (originated.entries.length !== incoming.entries.length || originated.tombstones.length !== incoming.tombstones.length) {
      this.host.logger.warn('cluster: ignored replicated changes the sender did not originate', { from: envelope.nodeId });
    }
    // A setting change that records no one who made it is not taken from another machine.
    const { document: own, dropped } = withRecordedActsOnly(originated);
    if (dropped > 0) this.noteUnrecorded(envelope.nodeId, [...originated.entries, ...originated.tombstones].filter((change) => !change.act));
    // A change taken with its record: whatever was said not taken for that path from this member is no longer so.
    this.noteRecorded(envelope.nodeId, [...own.entries, ...own.tombstones].map((change) => change.path));
    if (own.entries.length === 0 && own.tombstones.length === 0) return;
    if (!this.withinRevisionBound(Math.max(...own.entries.map((entry) => entry.revision), ...own.tombstones.map((entry) => entry.revision)), envelope.nodeId)) return;
    const gap = this.noteGap(before, own);
    await this.applyDocument(mergeConfigReplica(this.document, this.publicDocument(own)), envelope.nodeId, check);
    // The sender saw what this copy missed; ask it directly.
    if (gap) await this.requestSnapshot(envelope.nodeId);
  }

  private openSealed(envelope: ClusterEnvelope): string | null {
    const keys = this.host.nodeKeys();
    const sealed = envelope.body['sealed'];
    if (!keys || typeof sealed !== 'object' || sealed === null) return null;
    const forThisNode = (sealed as Record<string, unknown>)[this.host.nodeId];
    if (!forThisNode) return null;
    return openSealedEnvelope(
      keys.agreement,
      forThisNode as Parameters<typeof openSealedEnvelope>[1],
      SECRET_SEAL_CONTEXT,
    );
  }

  /**
   * Take a credential handed over by the group.
   *
   * The plaintext goes straight into this machine's OWN secret store, which
   * encrypts it under this machine's OWN keyfile. Another node's ciphertext is
   * never written verbatim, it could not be read back here anyway, and storing
   * it would quietly make the group's secrets undecryptable after a keyfile
   * rotation on one machine.
   */
  private async applySealedSecret(envelope: ClusterEnvelope, check: () => void): Promise<void> {
    const path = envelope.body['secretPath'];
    if (typeof path !== 'string' || !isReplicatedConfigPath(path)) return;
    await this.mutateSecret(path, check, async () => {
      const revision = envelope.body['revision'];
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) return;
      if (!this.withinRevisionBound(revision, envelope.nodeId)) return;
      const suppliedOrigin = envelope.body['origin'], existing = findReplicaEntry(this.document, path);
      if (suppliedOrigin !== undefined && (typeof suppliedOrigin !== 'string' || suppliedOrigin.length === 0 || suppliedOrigin.length > 256)) return;
      const origin = typeof suppliedOrigin === 'string' ? suppliedOrigin : existing?.secret && existing.revision === revision ? existing.origin : envelope.nodeId;
      // A credential that records no one who made it is not taken from another machine.
      const act = readReplicaAct(envelope.body['act']);
      if (!act) {
        if (origin === envelope.nodeId) this.noteUnrecorded(envelope.nodeId, [{ path, revision, origin }]);
        return;
      }
      if (origin === envelope.nodeId) this.noteRecorded(envelope.nodeId, [path]);
      const incoming: ConfigReplicaDocument = { version: 1, groupId: this.document.groupId, revision, tombstones: [], entries: [{
        path, revision, origin, at: this.host.now(), secret: true, value: { secretRevision: revision }, act,
      }] };
      const admitted = (): ConfigReplicaDocument | null => {
        const merged = mergeConfigReplica(this.document, incoming), selected = findReplicaEntry(merged, path);
        return selected?.secret && selected.revision === revision && selected.origin === origin ? merged : null;
      };
      if (!admitted()) return; // includes a tombstone at or above this revision
      const secrets = this.host.secrets(), secretKey = replicatedSecretKeyFor(path);
      if (!secrets || !isReplicatedSecretKey(secretKey)) return;
      const opened = this.openSealed(envelope); if (opened === null) return;
      check(); await secrets.set(secretKey, opened); check();
      // A newer document may have arrived during an entered set. Its queued
      // delete/write still owns the final store state; never resurrect metadata.
      const merged = admitted(); if (!merged) return;
      if (isSecretBearingConfigKey(path)) this.host.config()?.set(path, canonicalReplicatedSecretRef(path));
      // Applying this raises the revision to the secret's own, which would hide
      // a change that was missed in between; note it before it is lost.
      const gap = this.noteGap(this.document.revision, incoming);
      // The value is stored under exactly this revision: recorded in the same write.
      this.commit(withApplied(merged, { [path]: revision }), check);
      this.logApplied(path, envelope.nodeId, true, act);
      if (gap) await this.requestSnapshot(envelope.nodeId);
    });
  }

  /** Save the merged document, then apply what is not applied here yet (`pendingEffects`). */
  private async applyDocument(merged: ConfigReplicaDocument, from: string, check: () => void): Promise<void> {
    const before = this.document;
    // Nothing new: no write, no effects.
    if (merged.revision === before.revision && replicaDigest(merged) === this.digest) return;
    this.commit(merged, check);
    this.lastAppliedFrom = from; this.lastAppliedAt = this.host.now();
    await this.applyPendingEffects();
  }

  /** A genuine successful local edit retires an older failed remote effect: the local value is what is here now. */
  observeLocalChange(path: string): void {
    const next = this.appliedHere(this.document, path);
    if (next === this.document) return;
    try { this.commit(next, this.host.captureAuthority()); } catch { /* not a member now: nothing to retire */ }
  }

  /**
   * The housekeeping pass: apply group changes not yet applied here, and
   * publish held local changes.
   */
  async retryPendingEffects(): Promise<void> {
    await this.applyPendingEffects();
    await this.releaseHeld();
    await this.carryUnrecorded();
  }

  /**
   * The upgrade from a release that did not record who made a change (3.5.0): once, when this copy holds the group's
   * settings, every shared change THIS machine made that was already in its copy at its own upgrade (`carryThrough`,
   * stamped when this release first read the copy from disk) and records no one is marked the owner's, "carried from
   * before this record existed", and sent again under the same revision, so every member, and a machine that joins
   * later, takes it with nothing changed by hand. Never a change made after the upgrade (a hand edit since then records
   * no one and stays here), and never another machine's: each machine carries its own at its own upgrade, and a machine
   * removed from the group carries nothing, so its unrecorded changes are never re-sent as the owner's by the others
   * (gate-review-6 G14). A document this release made is born marked (`carried`).
   */
  private async carryUnrecorded(): Promise<void> {
    if (this.document.carried === true || !this.inStep) return;
    let check: () => void;
    try { check = this.host.captureAuthority(); } catch { return; }
    const through = this.document.carryThrough ?? -1;
    const ours = (change: { readonly origin: string; readonly revision: number }): boolean => change.origin === this.host.nodeId && change.revision <= through;
    // The record is added to the SAME change (its path, revision and origin unchanged): a copy that keeps who made it
    // wins over one that does not (config-replica.ts `beats`), and a newer change another machine made meanwhile, even
    // one this machine did not take, is never overwritten by an older value sent again at a new revision.
    const carry = <T extends { readonly act?: ReplicaAct | undefined; readonly origin: string; readonly revision: number }>(change: T): T =>
      change.act || !ours(change) ? change : { ...change, act: CARRIED_ACT };
    const entries = this.document.entries.map(carry);
    const tombstones = this.document.tombstones.map(carry);
    const settings = entries.filter((entry, index) => entry !== this.document.entries[index] && !entry.secret);
    const credentials = entries.filter((entry, index) => entry !== this.document.entries[index] && entry.secret);
    const deletions = tombstones.filter((tombstone, index) => tombstone !== this.document.tombstones[index]);
    this.commit({ ...this.document, entries, tombstones, carried: true }, check);
    // Only this machine's own changes are carried: they go to every member as deltas.
    if (settings.length > 0) await this.broadcastDelta(this.document, settings.map((entry) => entry.path), check);
    if (deletions.length > 0) await this.send(check, CONFIG_MESSAGE_TYPES.delta, { deletes: deletions });
    // A credential is sent again sealed under its own revision, with its value as stored here.
    for (const entry of credentials) {
      if (appliedRevision(this.document, entry.path) !== entry.revision) continue;
      try {
        const value = await this.effectiveSecret(entry.path, check);
        if (value !== null) await this.sendSealed(entry, value, check);
      } catch (error) {
        check();
        this.host.logger.warn('cluster: a credential made before who made changes was recorded could not be sent again', { path: entry.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const carried = settings.length + deletions.length + credentials.length;
    if (carried > 0) this.host.logger.info('cluster: shared changes made before who made them was recorded are marked yours and sent again', { carried });
  }

  /**
   * Apply what the document selects and this machine has not applied
   * (`pendingEffects`), then record what took effect in ONE write of the
   * document. A failure leaves its path pending; the next pass, or the next
   * start, applies it again. Credential deletions included: a deletion lost to
   * a restart is never left undone.
   */
  private async applyPendingEffects(): Promise<void> {
    const config = this.host.config(), secrets = this.host.secrets(); if (!config) return;
    const { sets, deletes } = this.pendingEffects();
    if (sets.length === 0 && deletes.length === 0) return;
    let check: () => void;
    try { check = this.host.captureAuthority(); } catch { return; }
    const applied: Record<string, number> = {};
    for (const entry of sets) {
      const path = entry.path;
      try {
        check();
        if (!sameEffect(findReplicaEntry(this.document, path), entry)) continue;
        if (JSON.stringify(config.get(path)) !== JSON.stringify(entry.value)) { config.set(path, entry.value); this.logApplied(path, entry.origin, false, entry.act); }
        applied[path] = entry.revision;
        this.localDifferences.delete(path);
      } catch (error) {
        if (error instanceof GroupConfigChangeRetiredError) continue;
        try { check(); } catch { break; }
        // Why it was not applied (a managed lock on this machine names itself and who set it).
        this.host.logger.warn('cluster: a replicated setting was not applied and is awaiting retry', { path, origin: entry.origin, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const tombstone of deletes) {
      const path = tombstone.path;
      const current = () => { check(); if (!sameEffect(selectedDeletion(this.document, path), tombstone)) throw new GroupConfigChangeRetiredError(); };
      try {
        current();
        if (tombstone.secret) {
          if (!secrets || (isSecretBearingConfigKey(path) && !config.reset)) throw new Error('Replicated credential deletion is unavailable');
          await this.mutateSecret(path, current, async () => { config.reset?.(path); await secrets.delete(replicatedSecretKeyFor(path)); });
        }
        else if (config.reset) config.reset(path);
        applied[path] = tombstone.revision;
        if (tombstone.secret || config.reset) this.host.logger.info('cluster: a setting was deleted by another machine in the group', { path, origin: tombstone.origin });
        else this.host.logger.warn('cluster: another machine in the group deleted a setting, but this machine\'s configuration store cannot reset it; the local value is unchanged', { path, origin: tombstone.origin });
      } catch (error) {
        if (error instanceof GroupConfigChangeRetiredError) continue;
        try { check(); } catch { break; }
        this.host.logger.warn('cluster: a replicated deletion was not confirmed and is awaiting retry', { path, origin: tombstone.origin });
      }
    }
    if (Object.keys(applied).length === 0) return;
    try { this.commit(withApplied(this.document, applied), check); }
    catch (error) {
      // Not saved: the effects are on this machine, and the next pass finds
      // them already in place and records them again.
      this.host.logger.debug('cluster: applied settings could not be recorded yet', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Every peer-sourced change is logged with the node it came from.
   *
   * A value is never logged, whether or not it is a secret: a replicated
   * surface token and a replicated surface id are equally nobody's business in
   * a log file, and the path plus the origin is what an operator actually needs
   * to answer "why did this machine change".
   */
  private logApplied(path: string, origin: string, secret: boolean, act?: ReplicaAct): void {
    this.host.logger.info('cluster: applied a setting from another machine in the group', {
      path,
      origin,
      kind: secret ? 'credential' : 'setting',
      ...(act ? { madeBy: describeReplicaAct(act) } : {}),
    });
  }

  /** Bound the document. Called from the group runtime's housekeeping pass. */
  sweep(now: number): void {
    this.snapshots.expire(now);
    const swept = sweepConfigReplica(this.document, now);
    if (swept.droppedTombstones === 0) return;
    this.commit(swept.document, this.host.captureAuthority());
    this.host.logger.debug('cluster: expired old replicated-setting deletions', {
      dropped: swept.droppedTombstones,
    });
  }

  /**
   * True while this machine should ask for the group's settings: it does not
   * hold them yet, it knows it missed a change, or a credential's value has
   * not arrived (asked for at a bounded rate). One small datagram per
   * housekeeping pass, stopping the moment the answer arrives.
   */
  get needsSnapshot(): boolean {
    const members = this.host.groupState()?.members ?? [];
    if (!members.some(member => member.nodeId !== this.host.nodeId)) return false;
    if (!this.inStep || this.resyncUntil !== null) return true;
    if (this.missingCredentials().length === 0) return false;
    return this.lastMissingSecretRequestAt === null || this.host.now() - this.lastMissingSecretRequestAt >= SECRET_REREQUEST_MS;
  }

  /**
   * Anti-entropy: another member gossiped what its copy holds.
   *
   * Equal digests mean equal settings, and nothing is sent. A different digest
   * means one side holds something the other lacks, whichever revision each
   * reports, so this side sends its document (the peer merges it) and asks the
   * peer for its own. That is what makes both sides of a healed split, and a
   * member that missed a datagram, end with the same settings. A peer that
   * sends no digest is compared by revision.
   */
  async notePeerReplica(from: string, revision: unknown, digest: unknown): Promise<void> {
    if (from === this.host.nodeId) return;
    if (typeof digest === 'string') {
      if (digest === this.digest) {
        this.divergentPeers.delete(from);
        if (!this.synced) { this.synced = true; await this.releaseHeld(); }
        return;
      }
    } else if (typeof revision !== 'number' || !Number.isFinite(revision) || revision <= this.document.revision) return;
    // A member known to run an older release holds a different copy by design (it keeps changes that record no one):
    // asked once, then not again until its release changes or it rejoins.
    if (this.olderPeers.has(from)) {
      const generation = (this.host.groupState()?.members ?? []).find((member) => member.nodeId === from)?.gen ?? -1;
      if (this.askedOlder.get(from) === generation) { this.divergentPeers.delete(from); return; }
      this.askedOlder.set(from, generation);
    }
    if (!this.divergentPeers.has(from) && this.divergentPeers.size >= MAX_GROUP_MEMBERS) return;
    this.divergentPeers.add(from);
    const now = this.host.now(), last = this.lastExchange.get(from);
    if (last !== undefined && now - last < EXCHANGE_MIN_INTERVAL_MS && now >= last) return;
    if (this.lastExchange.size >= MAX_GROUP_MEMBERS) this.lastExchange.clear();
    this.lastExchange.set(from, now);
    const check = this.host.captureAuthority();
    if (this.document.entries.length > 0 || this.document.tombstones.length > 0) await this.sendSnapshot(check);
    await this.requestSnapshot(from);
  }
}

/** A `cluster publish` or `cluster accept` that cannot act on the path it was given. */
export class ConfigLocalDifferenceError extends Error {
  constructor(readonly path: string, problem: string) {
    super(`${path} ${problem}`);
    this.name = 'ConfigLocalDifferenceError';
  }
}

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
  type ConfigReplicaDocument,
  type ConfigReplicaEntry,
  type ConfigReplicaTombstone,
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
}

/** The narrow slice of the secret store this layer touches. */
export interface ReplicatedSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  onDidChange?(listener: (key: string) => void): () => void;
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
    held.push({ path, kind, secret: record['secret'] === true, applyLocal: record['applyLocal'] === true });
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
  adopt(document: ConfigReplicaDocument, held: readonly HeldConfigChange[] = []): void {
    this.snapshots.clear();
    this.held.clear();
    this.resyncUntil = null; this.divergentPeers.clear(); this.lastExchange.clear();
    this.localDifferences.clear();
    this.synced = false;
    this.document = this.publicDocument(document);
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
      awaitingSync: !this.inStep || this.resyncUntil !== null || this.divergentPeers.size > 0,
      credentialsMissing: this.missingCredentials().length,
      changesNotApplied: (() => { const pending = this.pendingEffects(); return pending.sets.length + pending.deletes.length; })(),
      localChangesHeld: this.held.size,
      localDifferences: [...this.localDifferences].map(([path, difference]) => ({ path, origin: difference.origin })),
    };
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
  async reconcileLocalConfig(): Promise<void> {
    const check = this.host.captureAuthority();
    const config = this.host.config();
    if (!config || !this.inStep) return;
    let next = this.document;
    const changed: string[] = [];
    const agreed: Record<string, number> = {};
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
          this.host.logger.warn('cluster: this machine\'s value for a shared setting differs from the group\'s and was kept; run `cluster publish <path>` to send it to the group, or `cluster accept <path>` to take the group\'s', { path, origin: entry.origin });
        }
        continue;
      }
      next = putReplicaEntry(next, { path, value, origin: this.host.nodeId, at: this.host.now() });
      changed.push(path);
      agreed[path] = next.revision;
    }
    if (changed.length === 0 && Object.keys(agreed).length === 0) return;
    // One write for the batch: the new entries and the applied state together.
    this.commit(withApplied(next, agreed), check);
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
  async publishLocalValue(path: string): Promise<'published' | 'held'> {
    if (!isReplicatedConfigPath(path) || isSecretBearingConfigKey(path)) throw new ConfigLocalDifferenceError(path, 'is not a shared setting this command publishes');
    // Before this copy holds the group's settings the change is held, then sent.
    const held = !this.inStep;
    await this.announceLocalChange(path);
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
  async announceLocalChange(path: string, observed?: () => void): Promise<void> {
    if (!isReplicatedConfigPath(path)) return;
    const authority = this.host.captureAuthority();
    const check = observed ? () => { observed(); authority(); } : authority;
    const config = this.host.config();
    if (isSecretBearingConfigKey(path)) {
      // An emptied credential setting is the deletion, already made here.
      if (config?.get(path) !== '') await this.announceLocalSecret(path, check);
      else if (!this.inStep) this.hold(path, { kind: 'delete', secret: true, applyLocal: false });
      else await this.publishDelete(path, true, check, false);
      return;
    }
    const value = config?.get(path);
    if (!isReplicableValue(value)) return;
    if (!this.inStep) { this.hold(path, { kind: 'set', secret: false, applyLocal: false }); return; }
    const next = this.appliedHere(putReplicaEntry(this.document, { path, value, origin: this.host.nodeId, at: this.host.now() }), path);
    this.commit(next, check);
    await this.broadcastDelta(next, [path], check);
  }

  /** Replicate a secret the operator set on this machine. A seed publishes only a credential the group has no record of. */
  async announceLocalSecret(configPath: string, observed?: () => void, seed = false): Promise<void> {
    if (!isReplicatedConfigPath(configPath)) return;
    const authority = this.host.captureAuthority(), config = this.host.config();
    const classified = isSecretBearingConfigKey(configPath), configured = classified ? config?.get(configPath) : undefined;
    const check = () => { observed?.(); authority(); if (classified && config?.get(configPath) !== configured) throw new ConfigReplicationPrivacyError(); };
    const secrets = this.host.secrets();
    if (!secrets) return;
    if (seed && (!this.inStep || findReplicaEntry(this.document, configPath) || this.document.tombstones.some(entry => entry.path === configPath))) return;
    if (!this.inStep) { this.hold(configPath, { kind: 'secret', secret: true, applyLocal: false }); return; }
    const literal = classified ? this.credentialLiteral(configPath, configured) : null;
    const value = literal ?? await secrets.get(replicatedSecretKeyFor(configPath));
    check();
    if (value === null) { if (!seed) await this.publishDelete(configPath, true, check, false); return; }
    await this.publishSecret(configPath, value, check);
  }

  /** Delete a setting across the group. */
  async announceLocalDelete(path: string, secret = false, observed?: () => void): Promise<void> {
    if (!isReplicatedConfigPath(path)) return;
    const authority = this.host.captureAuthority();
    const check = observed ? () => { observed(); authority(); } : authority;
    if (!this.inStep) { this.hold(path, { kind: 'delete', secret, applyLocal: true }); return; }
    await this.publishDelete(path, secret, check, true);
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
        if (change.kind === 'delete') await this.publishDelete(path, change.secret, this.host.captureAuthority(), change.applyLocal);
        else if (change.kind === 'secret') await this.announceLocalSecret(path);
        else await this.announceLocalChange(path);
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

  private async publishDelete(path: string, secret: boolean, check: () => void, applyLocal: boolean): Promise<void> {
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
    const next = this.appliedHere(deleteReplicaEntry(this.document, { path, origin: this.host.nodeId, at, secret }), path);
    this.commit(next, check);
    await this.send(check, CONFIG_MESSAGE_TYPES.delta, {
      deletes: [{ path, revision: next.revision, origin: this.host.nodeId, at, secret }],
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
    await this.host.send(type, body);
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
  private async publishSecret(configPath: string, value: string, check: () => void): Promise<void> {
    // The value is in this machine's store already: applied under the new revision.
    const next = this.appliedHere(putReplicaEntry(this.document, {
      path: configPath,
      value: { secretRevision: this.document.revision + 1 },
      origin: this.host.nodeId,
      at: this.host.now(),
      secret: true,
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
    const header = { secretPath: entry.path, origin: entry.origin, revision: entry.revision };
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

  private async applySnapshot(incoming: ConfigReplicaDocument, from: string, check: () => void): Promise<void> {
    if (!this.withinRevisionBound(incoming.revision, from)) return;
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
    const own = { ...incoming, revision: before,
      entries: incoming.entries.filter((entry) => entry.origin === envelope.nodeId),
      tombstones: incoming.tombstones.filter((entry) => entry.origin === envelope.nodeId) };
    if (own.entries.length !== incoming.entries.length || own.tombstones.length !== incoming.tombstones.length) {
      this.host.logger.warn('cluster: ignored replicated changes the sender did not originate', { from: envelope.nodeId });
    }
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
      const incoming: ConfigReplicaDocument = { version: 1, groupId: this.document.groupId, revision, tombstones: [], entries: [{
        path, revision, origin, at: this.host.now(), secret: true, value: { secretRevision: revision },
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
      this.logApplied(path, envelope.nodeId, true);
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
        if (JSON.stringify(config.get(path)) !== JSON.stringify(entry.value)) { config.set(path, entry.value); this.logApplied(path, entry.origin, false); }
        applied[path] = entry.revision;
        this.localDifferences.delete(path);
      } catch (error) {
        if (error instanceof GroupConfigChangeRetiredError) continue;
        try { check(); } catch { break; }
        this.host.logger.warn('cluster: a replicated setting was not applied and is awaiting retry', { path, origin: entry.origin });
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
  private logApplied(path: string, origin: string, secret: boolean): void {
    this.host.logger.info('cluster: applied a setting from another machine in the group', {
      path,
      origin,
      kind: secret ? 'credential' : 'setting',
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

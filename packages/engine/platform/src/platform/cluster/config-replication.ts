/**
 * config-replication.ts, the master's settings, on every machine that might
 * have to serve them.
 *
 * Leader election decides which machine reads an inbox. That is only half an
 * answer: a machine that wins a surface and does not hold the surface's
 * configuration, or its credential, cannot serve it, and the handover is
 * theatre. This closes that.
 *
 * ── shape ──────────────────────────────────────────────────────────────────
 *
 *   The MASTER is the source of truth. It issues revisions, and it is the only
 *   node that writes one.
 *
 *   A machine that joins pulls a SNAPSHOT. From then on it receives DELTAS.
 *
 *   An edit made on a machine that is not the master is FORWARDED to the master
 *   as a proposal, and comes back as a delta like any other change. A standby
 *   never issues a revision of its own, so there is exactly one writer and no
 *   merge to argue about in the normal case.
 *
 * Everything rides the group transport and the group keyring, the same signed,
 * group-scoped channel every other cluster datagram uses. There is no second
 * channel and no second trust boundary.
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
  createConfigReplicaDocument,
  deleteReplicaEntry,
  findReplicaEntry,
  isReplicableValue,
  MAX_REVISION_ADVANCE,
  mergeConfigReplica,
  putReplicaEntry,
  readConfigReplicaDocument,
  sweepConfigReplica,
  type ConfigReplicaDocument,
  type ConfigReplicaTombstone,
} from './config-replica.js';
import type { GroupMember, GroupStateDocument } from './group-state.js';
import type { ClusterEnvelope } from './protocol-envelope.js';
import type { ClusterLogger } from './types.js';

/** Message types this layer speaks. All group-key signed, like everything else. */
export const CONFIG_MESSAGE_TYPES = {
  snapshot: 'CONFIG_SNAPSHOT',
  snapshotPart: CONFIG_SNAPSHOT_PART,
  delta: 'CONFIG_DELTA',
  propose: 'CONFIG_PROPOSE',
  request: 'CONFIG_REQUEST',
} as const;

const SECRET_SEAL_CONTEXT = 'goodvibes-cluster-config-secret-v1';

interface PendingReplicaEffect { readonly revision: number; readonly origin: string; readonly secret: boolean; readonly assertCurrent: () => void }
function sameEffect(entry: { revision: number; origin: string; secret: boolean } | null | undefined, selected: Pick<PendingReplicaEffect, 'revision' | 'origin' | 'secret'>): boolean {
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
  /** True when this machine is the one that issues revisions. */
  isMaster(): boolean;
  groupState(): GroupStateDocument | null;
  /** Original live membership/key/store owner, checked before every later effect.
   * Already-entered storage effects remain owned and are never blindly undone.
   */
  captureAuthority(envelope?: ClusterEnvelope): () => void;
  nodeKeys(): NodeKeyMaterial | null;
  config(): ReplicatedConfigStore | null;
  secrets(): ReplicatedSecretStore | null;
  /** Send an already-built group message. */
  send(type: string, body: Record<string, unknown>): Promise<void>;
  /** Persist the replica document alongside the roster. */
  persist(document: ConfigReplicaDocument): void;
}

/** What `cluster status` reports about replication. Never a value. */
export interface ConfigReplicationStatus {
  readonly revision: number;
  readonly entries: number;
  readonly secrets: number;
  readonly tombstones: number;
  readonly lastAppliedFrom: string | null;
  readonly lastAppliedAt: number | null;
  /** Edits made here that the responsible machine has not yet confirmed. */
  readonly pendingProposals: number;
  /**
   * True while this machine knows it missed a change and has asked for the full
   * state again. Its revision matches the group's during this time, so the
   * revision alone cannot show it.
   */
  readonly awaitingSync: boolean;
  /** Credentials the group says exist but whose value has not arrived here. */
  readonly credentialsMissing: number;
}

/** How often a machine that holds a credential marker without its value asks again. */
const SECRET_REREQUEST_MS = 60_000;
/** A proposal the master never acknowledges is resent this many times, then reported and dropped. */
const MAX_PROPOSAL_RETRIES = 5;

/** An unconfirmed proposal is not resent sooner than this, however often effects are retried. */
const PROPOSAL_RESEND_MS = 10_000;

interface PendingProposal { readonly kind: 'set' | 'secret' | 'delete'; readonly secret: boolean; readonly attempts: number; readonly sentAt: number }

export class ConfigReplicationService {
  private document: ConfigReplicaDocument;
  private readonly snapshots = new ConfigSnapshotTransfers();
  private lastAppliedFrom: string | null = null;
  private lastAppliedAt: number | null = null;
  private readonly proposals = new Map<string, PendingProposal>();
  private retryingProposals = false;
  /** Highest revision known to exist while this copy is missing part of it; null when nothing is missing. */
  private resyncUntil: number | null = null;
  private readonly missingSecrets = new Set<string>();
  private lastMissingSecretRequestAt: number | null = null;
  private readonly pendingSets = new Map<string, PendingReplicaEffect>();
  private readonly pendingDeletes = new Map<string, PendingReplicaEffect>();
  private pendingPersistence: (() => void) | null = null;
  private readonly secretMutations = new Map<string, Promise<void>>();

  constructor(private readonly host: ConfigReplicationHost, groupId: string) {
    this.document = createConfigReplicaDocument(groupId);
  }

  /** Adopt a document read back from disk, or from a group this node just joined. */
  adopt(document: ConfigReplicaDocument): void {
    this.snapshots.clear();
    this.pendingSets.clear(); this.pendingDeletes.clear(); this.pendingPersistence = null;
    this.proposals.clear(); this.resyncUntil = null; this.missingSecrets.clear();
    this.document = this.publicDocument(document);
  }

  retireSnapshotTransfers(): void { this.snapshots.clear(); }

  get replica(): ConfigReplicaDocument {
    return this.document;
  }

  status(): ConfigReplicationStatus {
    return {
      revision: this.document.revision,
      entries: this.document.entries.filter((entry) => !entry.secret).length,
      secrets: this.document.entries.filter((entry) => entry.secret).length,
      tombstones: this.document.tombstones.length,
      lastAppliedFrom: this.lastAppliedFrom,
      lastAppliedAt: this.lastAppliedAt,
      pendingProposals: this.proposals.size,
      awaitingSync: this.resyncUntil !== null,
      credentialsMissing: this.missingSecrets.size,
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

  private async effectiveSecret(path: string, assertCurrent: () => void): Promise<string | null> {
    const config = this.host.config(), classified = isSecretBearingConfigKey(path), configured = classified ? config?.get(path) : undefined;
    const literal = classified ? this.credentialLiteral(path, configured) : null;
    assertCurrent(); const value = literal ?? await this.host.secrets()?.get(replicatedSecretKeyFor(path)) ?? null;
    assertCurrent(); if (classified && config?.get(path) !== configured) throw new ConfigReplicationPrivacyError();
    return value;
  }

  // ── reconciling this machine's own config into the replica ────────────────

  /**
   * Fold local changes into the replica, and broadcast them.
   *
   * Runs on the master only. It is a reconcile rather than a change hook
   * as anti-entropy as well as the event bridge: comparing the replica
   * against what is actually on disk catches an edit made through any path at
   * all, including one made while this process was not running.
   */
  async reconcileLocalConfig(): Promise<void> {
    await this.reconcileLocal(this.host.captureAuthority());
  }

  private async reconcileLocal(assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (!this.host.isMaster()) return;
    const config = this.host.config();
    if (!config) return;

    let document = this.document;
    const changed: string[] = [];
    const deleted = new Set(document.tombstones.map((entry) => entry.path));
    for (const path of listReplicatedConfigPaths()) {
      // A path the group DELETED is never picked back up by a reconcile. A
      // local value can outlive the deletion, a store with no reset, or a
      // value written back by something else, and folding it in again would
      // undo the operator's deletion on the next housekeeping tick, which is
      // exactly what this loop did before the rule existed. Re-adding is an
      // explicit act: `announceLocalChange` clears the tombstone.
      if (deleted.has(path) || isSecretBearingConfigKey(path)) continue;
      const value = config.get(path);
      if (!isReplicableValue(value)) continue;
      const entry = findReplicaEntry(document, path);
      if (entry && JSON.stringify(entry.value) === JSON.stringify(value)) continue;
      document = putReplicaEntry(document, {
        path,
        value,
        origin: this.host.nodeId,
        at: this.host.now(),
      });
      changed.push(path);
    }
    if (changed.length === 0) return;
    this.document = document;
    assertCurrent();
    this.host.persist(document);
    await this.broadcastDelta(changed, assertCurrent);
    assertCurrent();
  }

  /**
   * Record an operator edit made on this machine, wherever it lands.
   *
   * On the master this writes the path EXPLICITLY rather than going through the
   * reconcile, because the reconcile deliberately skips anything the group has
   * deleted. Setting a deleted path again is the operator undoing the deletion,
   * and this is the only path that can.
   */
  async announceLocalChange(path: string, observed?: () => void): Promise<void> {
    if (!isReplicatedConfigPath(path)) return;
    const current = this.host.captureAuthority(); const assertCurrent = () => { observed?.(); current(); }; assertCurrent();
    const config = this.host.config();
    if (isSecretBearingConfigKey(path)) {
      const value = config?.get(path);
      if (value === '') await this.publishDelete(path, true, assertCurrent, false);
      else await this.announceLocalSecret(path, assertCurrent);
      return;
    }
    if (this.host.isMaster()) {
      const current = config?.get(path);
      if (!isReplicableValue(current)) return;
      this.document = putReplicaEntry(this.document, {
        path,
        value: current,
        origin: this.host.nodeId,
        at: this.host.now(),
      });
      assertCurrent();
      this.host.persist(this.document);
      assertCurrent();
      await this.broadcastDelta([path], assertCurrent);
      assertCurrent();
      return;
    }
    const value = config?.get(path);
    if (!isReplicableValue(value)) return;
    // Not the master, so this is a proposal rather than a change. The master
    // issues the revision and broadcasts it back; that is what keeps a single
    // writer in the normal case.
    this.registerProposal(path, 'set', false);
    assertCurrent();
    await this.send(assertCurrent, CONFIG_MESSAGE_TYPES.propose, { path, value, secret: false });
    assertCurrent();
  }

  /** Replicate a secret the operator set on this machine. */
  async announceLocalSecret(configPath: string, observed?: () => void, seed = false): Promise<void> {
    if (!isReplicatedConfigPath(configPath)) return;
    const current = this.host.captureAuthority(), config = this.host.config();
    const configured = isSecretBearingConfigKey(configPath) ? config?.get(configPath) : undefined;
    const assertCurrent = () => { observed?.(); current(); if (isSecretBearingConfigKey(configPath) && config?.get(configPath) !== configured) throw new ConfigReplicationPrivacyError(); }; assertCurrent();
    const secrets = this.host.secrets();
    if (!secrets || (seed && !this.host.isMaster())) return;
    const secretKey = replicatedSecretKeyFor(configPath);
    const literal = isSecretBearingConfigKey(configPath) ? this.credentialLiteral(configPath, configured) : null;
    const value = literal ?? await secrets.get(secretKey);
    assertCurrent();
    if (value === null) { if (!seed) await this.publishDelete(configPath, true, assertCurrent, false); return; }
    if (seed && this.document.tombstones.some(entry => entry.path === configPath)) return;
    if (!this.host.isMaster()) {
      this.registerProposal(configPath, 'secret', true);
      await this.sendSealed(CONFIG_MESSAGE_TYPES.propose, configPath, value, assertCurrent);
      assertCurrent();
      return;
    }
    await this.publishSecret(configPath, value, assertCurrent);
    assertCurrent();
  }

  /**
   * Remember an edit sent to the master until the group confirms it. Tracked per
   * path so one unrelated incoming change cannot make a lost proposal look
   * delivered.
   */
  private registerProposal(path: string, kind: PendingProposal['kind'], secret: boolean): void {
    const attempts = this.retryingProposals ? (this.proposals.get(path)?.attempts ?? 0) + 1 : 0;
    this.proposals.set(path, { kind, secret, attempts, sentAt: this.host.now() });
  }

  /** Forget the proposals the merged document now confirms. */
  private acknowledgeProposals(merged: ConfigReplicaDocument): void {
    for (const [path, proposal] of this.proposals) {
      if (proposal.kind === 'delete') {
        if (selectedDeletion(merged, path)) this.proposals.delete(path);
        continue;
      }
      const entry = findReplicaEntry(merged, path);
      if (proposal.kind === 'secret') {
        if (entry?.secret) this.proposals.delete(path);
      } else if (entry && !entry.secret && JSON.stringify(entry.value) === JSON.stringify(this.host.config()?.get(path))) {
        this.proposals.delete(path);
      }
    }
  }

  /** Send again each edit the master has not confirmed; give up, loudly, after a few tries. */
  private async resendProposals(): Promise<void> {
    if (this.host.isMaster()) { this.proposals.clear(); return; }
    this.retryingProposals = true;
    try {
      for (const [path, proposal] of [...this.proposals]) {
        if (this.proposals.get(path) !== proposal || this.host.now() - proposal.sentAt < PROPOSAL_RESEND_MS) continue;
        if (proposal.attempts >= MAX_PROPOSAL_RETRIES) {
          this.proposals.delete(path);
          this.host.logger.warn('cluster: the group never confirmed a setting changed on this machine; it stays local only', { path });
          continue;
        }
        try {
          if (proposal.kind === 'delete') await this.announceLocalDelete(path, proposal.secret);
          else if (proposal.kind === 'secret') await this.announceLocalSecret(path);
          else await this.announceLocalChange(path);
        } catch (error) {
          this.host.logger.debug('cluster: resending an unconfirmed setting failed', { path, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally { this.retryingProposals = false; }
  }

  /** Delete a setting across the group. */
  async announceLocalDelete(path: string, secret = false, observed?: () => void): Promise<void> {
    if (!isReplicatedConfigPath(path)) return;
    const current = this.host.captureAuthority(); const assertCurrent = () => { observed?.(); current(); }; assertCurrent();
    await this.publishDelete(path, secret, assertCurrent, true);
  }
  private async publishDelete(path: string, secret: boolean, assertCurrent: () => void, applyLocal: boolean): Promise<void> {
    assertCurrent();
    if (!this.host.isMaster()) {
      this.registerProposal(path, 'delete', secret);
      await this.send(assertCurrent, CONFIG_MESSAGE_TYPES.propose, { path, secret, delete: true }); return;
    }
    const secrets = this.host.secrets();
    this.document = deleteReplicaEntry(this.document, {
      path,
      origin: this.host.nodeId,
      at: this.host.now(),
      secret,
    });
    // Clear it here too, where the store can. A deletion the operator made on
    // the group should not leave this machine still running the old value.
    assertCurrent(); if (applyLocal) this.host.config()?.reset?.(path);
    assertCurrent();
    if (applyLocal && secret && secrets) { await this.mutateSecret(path, assertCurrent, () => secrets.delete(replicatedSecretKeyFor(path))); assertCurrent(); }
    assertCurrent();
    this.host.persist(this.document);
    assertCurrent();
    await this.send(assertCurrent, CONFIG_MESSAGE_TYPES.delta, {
      deletes: [{ path, revision: this.document.revision, origin: this.host.nodeId, at: this.host.now(), secret }],
    });
  }

  /** Serialize entered writes/deletes for one actual credential. Queue only
   * encrypted input/guards or callbacks, never decrypted credential caches.
   */
  private mutateSecret(path: string, assertCurrent: () => void, effect: () => Promise<void>): Promise<void> {
    const previous = this.secretMutations.get(path) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => { assertCurrent(); await effect(); assertCurrent(); });
    this.secretMutations.set(path, task);
    const drained = () => { if (this.secretMutations.get(path) === task) this.secretMutations.delete(path); };
    void task.then(drained, drained); return task;
  }

  // ── sending ───────────────────────────────────────────────────────────────

  private async send(assertCurrent: () => void, type: string, body: Record<string, unknown>): Promise<void> {
    assertCurrent();
    await this.host.send(type, body);
    assertCurrent();
  }

  private async broadcastDelta(paths: readonly string[], assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const entries = this.document.entries.filter((entry) => paths.includes(entry.path) && !entry.secret);
    if (entries.length === 0) return;
    const body = { entries };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= CONFIG_BODY_LIMIT) await this.send(assertCurrent, CONFIG_MESSAGE_TYPES.delta, body);
    else await this.sendSnapshot(assertCurrent);
  }

  private async sendSnapshot(assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const document = this.document;
    // Serialization below captures this exact immutable wire image before
    // yielding. A later legitimate revision does not revoke this older signed
    // image; receivers merge its per-entry revisions. Membership/entered-change
    // authority remains fenced through every send.
    const current = assertCurrent;
    const body = { document };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= CONFIG_BODY_LIMIT) {
      await this.send(current, CONFIG_MESSAGE_TYPES.snapshot, body);
      return;
    }
    for (const part of prepareConfigSnapshotTransfer(document, document.revision)) {
      await this.send(current, CONFIG_MESSAGE_TYPES.snapshotPart, { ...part });
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
  private async publishSecret(configPath: string, value: string, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    this.document = putReplicaEntry(this.document, {
      path: configPath,
      value: { secretRevision: this.document.revision + 1 },
      origin: this.host.nodeId,
      at: this.host.now(),
      secret: true,
    });
    assertCurrent();
    this.host.persist(this.document);
    assertCurrent();
    await this.sendSealed(CONFIG_MESSAGE_TYPES.delta, configPath, value, assertCurrent);
    assertCurrent();
  }

  /** Seal `value` to every current member and send it. */
  private async sendSealed(type: string, configPath: string, value: string, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const members = this.host.groupState()?.members ?? [];
    const sealed: Record<string, unknown> = {};
    for (const member of members) {
      if (member.nodeId === this.host.nodeId) continue;
      sealed[member.nodeId] = sealForMember(member.agreementKey, value, SECRET_SEAL_CONTEXT);
    }
    if (Object.keys(sealed).length === 0) return;
    await this.send(assertCurrent, type, {
      secretPath: configPath,
      origin: findReplicaEntry(this.document, configPath)?.origin ?? this.host.nodeId,
      revision: this.document.revision,
      sealed,
    });
  }

  /** Ask the group for everything. Sent by a machine that has just joined. */
  async requestSnapshot(): Promise<void> {
    const assertCurrent = this.host.captureAuthority(); assertCurrent();
    this.lastMissingSecretRequestAt = this.host.now();
    await this.send(assertCurrent, CONFIG_MESSAGE_TYPES.request, {});
    assertCurrent();
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  /** Route a config-replication datagram that already verified under the group key. */
  async handle(envelope: ClusterEnvelope): Promise<void> {
    const assertCurrent = this.host.captureAuthority(envelope); assertCurrent();
    switch (envelope.type) {
      case CONFIG_MESSAGE_TYPES.request:
        await this.onRequest(envelope, assertCurrent);
        assertCurrent();
        return;
      case CONFIG_MESSAGE_TYPES.snapshotPart:
        await this.onSnapshotPart(envelope, assertCurrent);
        assertCurrent();
        return;
      case CONFIG_MESSAGE_TYPES.snapshot:
        await this.onSnapshot(envelope, assertCurrent);
        assertCurrent();
        return;
      case CONFIG_MESSAGE_TYPES.delta:
        await this.onDelta(envelope, assertCurrent);
        assertCurrent();
        return;
      case CONFIG_MESSAGE_TYPES.propose:
        await this.onPropose(envelope, assertCurrent);
        assertCurrent();
        return;
      default:
    }
  }

  private async onRequest(envelope: ClusterEnvelope, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (!this.host.isMaster() || envelope.nodeId === this.host.nodeId) return;
    await this.sendSnapshot(assertCurrent);
    assertCurrent();
    // Secrets are not in the document, so each one is sent sealed to the asker.
    const secrets = this.host.secrets();
    const member = this.host.groupState()?.members.find((entry) => entry.nodeId === envelope.nodeId);
    if (!secrets || !member) return;
    for (const entry of this.document.entries.filter((candidate) => candidate.secret)) {
      assertCurrent();
      // One credential that cannot be sent must not stop the ones after it.
      try {
        const value = await this.effectiveSecret(entry.path, assertCurrent);
        assertCurrent();
        if (findReplicaEntry(this.document, entry.path) !== entry) throw new Error('Original replicated secret entry changed');
        if (value === null) continue;
        await this.send(assertCurrent, CONFIG_MESSAGE_TYPES.delta, {
          secretPath: entry.path,
          origin: entry.origin,
          revision: entry.revision,
          sealed: { [member.nodeId]: sealForMember(member.agreementKey, value, SECRET_SEAL_CONTEXT) },
        });
      } catch (error) {
        // Losing authority (membership changed, shutdown) still ends the whole pass.
        assertCurrent();
        this.host.logger.warn('cluster: a credential could not be sent to a joining machine and was skipped', { path: entry.path, to: member.nodeId, error: error instanceof Error ? error.message : String(error) });
      }
      assertCurrent();
    }
  }

  private async onSnapshotPart(envelope: ClusterEnvelope, assertCurrent: () => void): Promise<void> {
    if (envelope.nodeId === this.host.nodeId) return;
    const complete = this.snapshots.accept(envelope, this.host.now(), assertCurrent);
    if (!complete) return;
    complete.assertCurrent(); assertCurrent();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(complete.bytes)); } catch { return; }
    const incoming = readConfigReplicaDocument(value, isReplicatedConfigPath);
    if (!incoming || incoming.groupId !== this.document.groupId || incoming.revision !== complete.revision) return;
    const current = () => { complete.assertCurrent(); assertCurrent(); };
    if (!this.withinRevisionBound(incoming.revision, envelope.nodeId)) return;
    await this.applyDocument(mergeConfigReplica(this.document, this.publicDocument(incoming)), envelope.nodeId, current);
    current();
    this.noteSnapshotApplied(incoming.revision);
  }

  private async onSnapshot(envelope: ClusterEnvelope, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (envelope.nodeId === this.host.nodeId) return;
    const incoming = readConfigReplicaDocument(envelope.body['document'], isReplicatedConfigPath);
    if (!incoming) {
      this.host.logger.debug('cluster: a config snapshot did not parse and was ignored', {
        from: envelope.nodeId,
      });
      return;
    }
    if (!this.withinRevisionBound(incoming.revision, envelope.nodeId)) return;
    const merged = mergeConfigReplica(this.document, this.publicDocument(incoming));
    await this.applyDocument(merged, envelope.nodeId, assertCurrent);
    assertCurrent();
    this.noteSnapshotApplied(incoming.revision);
  }

  /** A document claiming a revision far beyond this copy's own is not applied. */
  private withinRevisionBound(revision: number, from: string): boolean {
    if (revision <= this.document.revision + MAX_REVISION_ADVANCE) return true;
    this.host.logger.warn('cluster: ignored replicated settings claiming an implausible revision', { from, revision, local: this.document.revision });
    return false;
  }

  /** A full snapshot at or past the revision known to exist closes a detected gap. */
  private noteSnapshotApplied(revision: number): void {
    if (this.resyncUntil !== null && revision >= this.resyncUntil) this.resyncUntil = null;
  }

  /**
   * Revisions are issued one at a time, so an incoming change that starts more
   * than one past this copy's revision means something in between never
   * arrived. The revision counter alone cannot show that: merging raises it to
   * the newest value seen, which would make both machines report the same
   * revision while one is missing a setting.
   */
  private noteGap(before: number, incoming: ConfigReplicaDocument): boolean {
    // A copy with nothing yet is already asking for everything (`needsSnapshot`).
    if (this.host.isMaster() || before === 0) return false;
    const revisions = [...incoming.entries.map((entry) => entry.revision), ...incoming.tombstones.map((entry) => entry.revision)];
    if (revisions.length === 0 || Math.min(...revisions) <= before + 1) return false;
    this.resyncUntil = Math.max(this.resyncUntil ?? 0, ...revisions);
    return true;
  }

  private async onDelta(envelope: ClusterEnvelope, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (envelope.nodeId === this.host.nodeId) return;
    if (typeof envelope.body['secretPath'] === 'string') {
      await this.applySealedSecret(envelope, assertCurrent);
      assertCurrent();
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
    await this.applyDocument(mergeConfigReplica(this.document, this.publicDocument(own)), envelope.nodeId, assertCurrent);
    assertCurrent();
    if (gap) await this.requestSnapshot();
  }

  /**
   * A proposal from a machine that is not the master.
   *
   * Only the master acts on one, and it re-derives the value from its own
   * policy check before issuing a revision, a peer does not get to name a path
   * this machine would not have replicated itself.
   */
  private async onPropose(envelope: ClusterEnvelope, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (!this.host.isMaster() || envelope.nodeId === this.host.nodeId) return;
    if (envelope.body['delete'] !== undefined) {
      const path = envelope.body['path'], secret = envelope.body['secret'];
      if (Object.keys(envelope.body).length !== 3 || envelope.body['delete'] !== true || typeof path !== 'string'
        || !isReplicatedConfigPath(path) || typeof secret !== 'boolean') return;
      await this.announceLocalDelete(path, secret, assertCurrent); assertCurrent(); return;
    }
    if (typeof envelope.body['secretPath'] === 'string') {
      const path = envelope.body['secretPath']; if (!isReplicatedConfigPath(path)) return;
      await this.mutateSecret(path, assertCurrent, async () => {
        const opened = this.openSealed(envelope), secrets = this.host.secrets(); if (opened === null || !secrets) return;
        const original = findReplicaEntry(this.document, path), deleted = this.document.tombstones.find(entry => entry.path === path);
        assertCurrent(); await secrets.set(replicatedSecretKeyFor(path), opened); assertCurrent();
        if (findReplicaEntry(this.document, path) !== original || this.document.tombstones.find(entry => entry.path === path) !== deleted) return;
        if (isSecretBearingConfigKey(path)) { this.host.config()?.set(path, canonicalReplicatedSecretRef(path)); assertCurrent(); }
        this.logApplied(path, envelope.nodeId, true); assertCurrent();
        await this.publishSecret(path, opened, assertCurrent); assertCurrent();
      });
      return;
    }
    const path = envelope.body['path'];
    const value = envelope.body['value'];
    if (typeof path !== 'string' || !isReplicatedConfigPath(path) || !isReplicableValue(value)) return;
    const config = this.host.config();
    if (!config) return;
    if (isSecretBearingConfigKey(path) && !publicCredentialPointer(path, value)) { this.host.logger.warn('cluster: refused public credential proposal; use the encrypted credential setting', { path }); return; }
    assertCurrent(); config.set(path, value);
    assertCurrent();
    this.logApplied(path, envelope.nodeId, false);
    assertCurrent();
    await this.announceLocalChange(path, assertCurrent);
    assertCurrent();
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
  private async applySealedSecret(envelope: ClusterEnvelope, assertCurrent: () => void): Promise<void> {
    const path = envelope.body['secretPath'];
    if (typeof path !== 'string' || !isReplicatedConfigPath(path)) return;
    await this.mutateSecret(path, assertCurrent, async () => {
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
      assertCurrent(); await secrets.set(secretKey, opened); assertCurrent();
      // A newer document may have arrived during an entered set. Its queued
      // delete/write still owns the final store state; never resurrect metadata.
      const merged = admitted(); if (!merged) return;
      if (isSecretBearingConfigKey(path)) { assertCurrent(); this.host.config()?.set(path, canonicalReplicatedSecretRef(path)); assertCurrent(); }
      // Applying this raises the revision to the secret's own, which would hide
      // a change that was missed in between; note it before it is lost.
      const gap = this.noteGap(this.document.revision, incoming);
      this.missingSecrets.delete(path);
      this.document = merged;
      this.host.persist(merged); assertCurrent(); this.logApplied(path, envelope.nodeId, true);
      this.acknowledgeProposals(merged);
      if (gap) await this.requestSnapshot();
    });
  }

  /** Persist desired metadata first. Only newly selected effects, or the exact
   * original failed effect, are admitted; historical tombstones are not commands.
   */
  private async applyDocument(merged: ConfigReplicaDocument, from: string, assertCurrent: () => void): Promise<void> {
    assertCurrent(); const before = this.document; this.document = merged;
    for (const entry of merged.entries) {
      if (entry.secret) continue;
      const previous = findReplicaEntry(before, entry.path);
      if (!previous || !sameEffect(previous, entry)) this.pendingSets.set(entry.path, { revision: entry.revision, origin: entry.origin, secret: false, assertCurrent });
    }
    for (const tombstone of merged.tombstones) {
      const selected = selectedDeletion(merged, tombstone.path); if (selected !== tombstone) continue;
      const previous = selectedDeletion(before, tombstone.path);
      if (!previous || !sameEffect(previous, tombstone)) this.pendingDeletes.set(tombstone.path, { revision: tombstone.revision, origin: tombstone.origin, secret: tombstone.secret, assertCurrent });
    }
    this.pendingPersistence = assertCurrent; assertCurrent(); this.host.persist(merged); assertCurrent(); this.pendingPersistence = null;
    await this.retryPendingEffects(); assertCurrent();
    this.lastAppliedFrom = from; this.lastAppliedAt = this.host.now(); this.acknowledgeProposals(merged);
  }

  /** A genuine successful local edit retires an older failed remote effect. */
  observeLocalChange(path: string): void { this.pendingSets.delete(path); this.pendingDeletes.delete(path); }

  /** Retry only original failed desired-state effects. Maps retain finite path
   * metadata/authority guards, never a second copy of config or secret values.
   */
  async retryPendingEffects(): Promise<void> {
    if (this.pendingPersistence) { const original = this.pendingPersistence; original(); this.host.persist(this.document); original(); if (this.pendingPersistence === original) this.pendingPersistence = null; }
    const config = this.host.config(), secrets = this.host.secrets(); if (!config) return;
    for (const [path, effect] of this.pendingSets) {
      const entry = findReplicaEntry(this.document, path);
      if (!sameEffect(entry, effect) || !entry || entry.secret) { if (this.pendingSets.get(path) === effect) this.pendingSets.delete(path); continue; }
      const current = () => { effect.assertCurrent(); if (!sameEffect(findReplicaEntry(this.document, path), effect) || this.pendingSets.get(path) !== effect) throw new GroupConfigChangeRetiredError(); };
      try {
        current(); if (JSON.stringify(config.get(path)) !== JSON.stringify(entry.value)) { config.set(path, entry.value); current(); this.logApplied(path, entry.origin, false); }
        if (this.pendingSets.get(path) === effect) this.pendingSets.delete(path);
      } catch {
        try { current(); } catch { if (this.pendingSets.get(path) === effect) this.pendingSets.delete(path); continue; }
        this.host.logger.warn('cluster: a replicated setting was not applied and is awaiting retry', { path, origin: effect.origin });
      }
    }
    for (const [path, effect] of this.pendingDeletes) {
      const current = () => { effect.assertCurrent(); if (!sameEffect(selectedDeletion(this.document, path), effect) || this.pendingDeletes.get(path) !== effect) throw new GroupConfigChangeRetiredError(); };
      try {
        current();
        if (effect.secret) {
          if (!secrets || (isSecretBearingConfigKey(path) && !config.reset)) throw new Error('Replicated credential deletion is unavailable');
          await this.mutateSecret(path, current, async () => { current(); config.reset?.(path); current(); await secrets.delete(replicatedSecretKeyFor(path)); current(); });
        }
        else if (config.reset) config.reset(path);
        current(); if (this.pendingDeletes.get(path) === effect) this.pendingDeletes.delete(path);
        if (effect.secret || config.reset) this.host.logger.info('cluster: a setting was deleted by another machine in the group', { path, origin: effect.origin });
        else this.host.logger.warn('cluster: another machine in the group deleted a setting, but this machine\'s configuration store cannot reset it; the local value is unchanged', { path, origin: effect.origin });
      } catch {
        try { current(); } catch { if (this.pendingDeletes.get(path) === effect) this.pendingDeletes.delete(path); continue; }
        this.host.logger.warn('cluster: a replicated deletion was not confirmed and is awaiting retry', { path, origin: effect.origin });
      }
    }
    await this.refreshMissingSecrets(secrets);
    await this.resendProposals();
  }

  /**
   * Note the credentials the group says exist that this machine does not hold.
   *
   * The document carries only the fact that a credential exists; its value
   * travels separately and once. A machine that has the first without the
   * second looks complete in `cluster status` and cannot serve the surface.
   */
  private async refreshMissingSecrets(secrets: ReplicatedSecretStore | null): Promise<void> {
    if (this.host.isMaster() || !secrets) { this.missingSecrets.clear(); return; }
    const present = new Set<string>();
    for (const entry of this.document.entries) {
      if (!entry.secret) continue;
      present.add(entry.path);
      try {
        if (await secrets.get(replicatedSecretKeyFor(entry.path)) === null) this.missingSecrets.add(entry.path);
        else this.missingSecrets.delete(entry.path);
      } catch { /* unreadable store: leave the earlier reading */ }
    }
    for (const path of this.missingSecrets) if (!present.has(path)) this.missingSecrets.delete(path);
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
    const assertCurrent = this.host.captureAuthority(); assertCurrent();
    const swept = sweepConfigReplica(this.document, now);
    if (swept.droppedTombstones === 0) return;
    assertCurrent(); this.document = swept.document;
    this.host.persist(swept.document);
    assertCurrent();
    this.host.logger.debug('cluster: expired old replicated-setting deletions', {
      dropped: swept.droppedTombstones,
    });
  }

  /**
   * True while this machine still has nothing and is not the one issuing
   * revisions, the condition under which it should keep asking.
   *
   * Asking again is how a snapshot that was missed because the master was busy,
   * or was sent while this machine was still starting, is recovered. It costs
   * one small datagram per housekeeping pass and stops the moment anything
   * arrives.
   */
  get needsSnapshot(): boolean {
    if (this.host.isMaster()) return false;
    if (this.document.revision === 0 || this.resyncUntil !== null) return true;
    if (this.missingSecrets.size === 0) return false;
    // A credential the master cannot send would otherwise be asked for on every pass.
    return this.lastMissingSecretRequestAt === null || this.host.now() - this.lastMissingSecretRequestAt >= SECRET_REREQUEST_MS;
  }

  /**
   * Anti-entropy: another member says it is at `revision`.
   *
   * A machine that was partitioned when a change went out never receives that
   * delta, and nothing else would ever tell it. Every roster gossip carries the
   * sender's revision, so a machine that is behind notices on the next one and
   * asks for a snapshot, which carries the DELETIONS as well as the values,
   * and is therefore what stops a healed partition from running settings the
   * operator removed while it was away.
   */
  async notePeerRevision(revision: number): Promise<void> {
    if (!Number.isFinite(revision) || revision <= this.document.revision) return;
    if (this.host.isMaster()) return;
    await this.requestSnapshot();
  }
}

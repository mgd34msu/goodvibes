/**
 * push/subscription-store.ts
 *
 * The on-disk record of which devices an operator has registered for browser
 * push. Persisted with the same atomic-JSON `PersistentStore` the approval and
 * session stores use, the capability URLs and key material stay on disk in the
 * daemon's own state directory, never on the wire.
 *
 * Delete means delete: `remove()` drops the record entirely (it does not flag a
 * tombstone), and `list()` cannot return it afterward. A removal is in force on
 * this machine at once; it reaches the other machines of the group with the
 * authority-record write that carries it. When that write fails, the removal is
 * kept in this file as a pending revocation: no read here serves the device,
 * and every later write carries the revocation again until one reaches the
 * record.
 *
 * Every write refuses while the authority record exists but cannot be read
 * (`AuthorityRecordUnavailableError`), so an unreadable record never empties
 * this file or turns a delete into a not-found. The one exception is the
 * revocation of a user who lost admin access: it is kept in this file as a
 * pending principal revocation, and the first write that can read the record
 * revokes that user's devices there.
 *
 * Dead records (see subscription-housekeeping.ts for what counts as evidence)
 * are left out of every read, and dropped from the file by whichever write
 * happens next: a registration, a delete, or the outcome stamp of a delivery.
 * There is no timer and no separate sweep. The latest removal per principal is
 * kept in the same file so `push.subscriptions.list` can say why a device
 * stopped receiving.
 *
 * The authority record (cluster/authority-record.ts) is the answer to which
 * devices are registered: every registration is a `push-endpoint` entry there
 * (its endpoint and keys sealed to each machine of the group, never in clear),
 * and every removal, here or on another machine, is a terminal revocation. A
 * device registered through one machine of the group receives that machine's
 * and every other machine's pushes, and a device turned off anywhere receives
 * none, from any machine, including one that was asleep or restarted. This
 * file keeps what is local to this machine: delivery outcomes, failure counts
 * and the latest removal per principal.
 *
 * Concurrency: there is no process-local cache. Every read goes to disk, so a
 * revocation takes effect on the very next lookup rather than after a restart.
 * Every read-modify-write runs under an in-process queue and the process lock
 * (`<store>.json.writer.sqlite`, released by the kernel if the process dies),
 * so a second daemon's registration cannot be clobbered by this one's write.
 */

import { createHash, randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.js';
import { AuthorityRecordUnavailableError, type AuthorityChange, type AuthorityRecordFile } from '../cluster/authority-record-file.js';
import type { AuthorityKey } from '../cluster/authority-record.js';
import { withProcessLock } from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';
import { pairingTokenIdOfPrincipal } from '../pairing/principal-ids.js';
import {
  DEFAULT_PUSH_SUBSCRIPTION_POLICY,
  endpointOriginOf,
  findDeadPushRecords,
  removalOf,
  type PushSubscriptionPolicy,
  type PushSubscriptionRemoval,
} from './subscription-housekeeping.js';
import { assertUsableSubscription } from './subscription-validation.js';
import type {
  PublicPushSubscription,
  PushReconcileDrift,
  StoredPushSubscription,
  SubscriptionKeyMaterial,
} from './types.js';

interface SubscriptionSnapshot extends Record<string, unknown> {
  readonly subscriptions: readonly StoredPushSubscription[];
  /** The latest removal of each principal's devices, keyed by principal id. */
  readonly lastRemovals?: Readonly<Record<string, PushSubscriptionRemoval>> | undefined;
  /** Removals made here that have not yet reached the authority record; absent when none wait. */
  readonly pendingRevocations?: readonly PendingRevocation[] | undefined;
  /**
   * Principals whose devices were revoked while the authority record could not
   * be read, so their devices could not all be named yet; absent when none wait.
   */
  readonly pendingPrincipalRevocations?: readonly PendingPrincipalRevocation[] | undefined;
}

/** Every device a principal registered up to `at`, revoked; carried until a write can name them on the authority record. */
interface PendingPrincipalRevocation {
  readonly principalId: string;
  readonly evidence: string;
  readonly at: number;
}

function readPendingPrincipalRevocations(value: unknown): PendingPrincipalRevocation[] {
  if (!Array.isArray(value)) return [];
  const pending: PendingPrincipalRevocation[] = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { principalId, evidence, at } = item as Record<string, unknown>;
    if (typeof principalId === 'string' && typeof evidence === 'string' && typeof at === 'number' && Number.isFinite(at)) pending.push({ principalId, evidence, at });
  }
  return pending;
}

/** Whether a pending principal revocation covers this record: that principal's, registered no later than the revocation. */
function revokedByPrincipal(record: StoredPushSubscription, principals: readonly PendingPrincipalRevocation[]): PendingPrincipalRevocation | undefined {
  return principals.find((entry) => entry.principalId === record.principalId && record.createdAt <= entry.at);
}

/** A removal on its way to the authority record. */
interface PendingRevocation {
  readonly id: string;
  readonly by: string;
  readonly reason: string;
}

function readPendingRevocations(value: unknown): PendingRevocation[] {
  if (!Array.isArray(value)) return [];
  const pending: PendingRevocation[] = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { id, by, reason } = item as Record<string, unknown>;
    if (typeof id === 'string' && typeof by === 'string' && typeof reason === 'string') pending.push({ id, by, reason });
  }
  return pending;
}

/** The union of revocation lists, one entry per id (the first one listed wins). */
function mergeRevocations(...lists: readonly (readonly PendingRevocation[])[]): PendingRevocation[] {
  const byId = new Map<string, PendingRevocation>();
  for (const list of lists) for (const revocation of list) if (!byId.has(revocation.id)) byId.set(revocation.id, revocation);
  return [...byId.values()];
}

export interface RegisterSubscriptionInput {
  readonly principalId: string;
  /** Stable device identity; when present the record reconciles on it, not the endpoint. */
  readonly deviceId?: string | undefined;
  readonly endpoint: string;
  readonly keys: SubscriptionKeyMaterial;
}

/** The outcome of a reconcile-on-open: the healed record plus what drifted. */
export interface ReconcileResult {
  readonly record: StoredPushSubscription;
  readonly drift: PushReconcileDrift;
}

/** Construction knobs; all optional so the stock store is one path argument. */
export interface PushSubscriptionStoreOptions {
  /** Policy; absent ⇒ {@link DEFAULT_PUSH_SUBSCRIPTION_POLICY}. */
  readonly policy?: (() => PushSubscriptionPolicy) | PushSubscriptionPolicy | undefined;
  /** Clock seam so removal timestamps are deterministic under test. */
  readonly now?: (() => number) | undefined;
  /** The authority record the registrations live on; absent, this file answers alone. */
  readonly authority?: AuthorityRecordFile | undefined;
}

const endpointKey = (id: string): AuthorityKey => `push-endpoint:${id}`;

/** The endpoint's digest: what the record shows of a capability URL in clear. */
export function pushEndpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

/**
 * What one delivery attempt proved about a subscription, applied by
 * {@link PushSubscriptionStore.applyOutcomes}.
 *  - `delivered`: the push service accepted it; the rejection count resets.
 *  - `unproven`: it failed for a reason that says nothing about the endpoint (a
 *    network error, a timeout, 408, 413, 429, a 5xx); recorded, never counted.
 *  - `rejected`: the push service refused the endpoint; counted toward the bound.
 *  - `gone`: the push service answered 404 or 410; the record is removed.
 */
export interface PushOutcomeStamp {
  readonly subscriptionId: string;
  /**
   * The endpoint the attempt was sent to. A subscription refreshed in place
   * keeps its id and gets a new endpoint, so a late answer about the old
   * endpoint (a 410 for it) must not touch the refreshed record.
   */
  readonly endpoint: string;
  readonly evidence: 'delivered' | 'unproven' | 'rejected' | 'gone';
  /** Plain-language reason, written into the removal when the record is dropped. */
  readonly detail: string;
}

/** What a stamp did to its record. */
export interface AppliedPushOutcome {
  /** Consecutive rejections after the stamp (0 after a delivery). */
  readonly consecutiveFailures: number;
  /** Present when the stamp removed the record. */
  readonly removed?: PushSubscriptionRemoval | undefined;
  /** True when the record's endpoint changed since the attempt, so the stamp was not applied. */
  readonly superseded?: true | undefined;
}

/** A principal's devices and the latest removal among them: the push status. */
export interface PushSubscriptionStatus {
  readonly subscriptions: PublicPushSubscription[];
  readonly lastRemoval?: PushSubscriptionRemoval | undefined;
}

/** The redacted, wire-safe projection of a stored subscription. */
export function toPublicSubscription(record: StoredPushSubscription): PublicPushSubscription {
  return {
    id: record.id,
    principalId: record.principalId,
    ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
    endpointOrigin: endpointOriginOf(record.endpoint),
    createdAt: record.createdAt,
    lastDeliveryAt: record.lastDeliveryAt,
    lastOutcome: record.lastOutcome,
    ...(record.consecutiveFailures ? { consecutiveFailures: record.consecutiveFailures } : {}),
  };
}

export class PushSubscriptionStore {
  private readonly store: PersistentStore<SubscriptionSnapshot>;
  /** The cross-process lock file, or null for an in-memory store. */
  private readonly lockPath: string | null;
  private readonly policy: () => PushSubscriptionPolicy;
  private readonly now: () => number;
  /** Serializes in-process mutations so two writes cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly authority: AuthorityRecordFile | undefined;

  constructor(filePath: string, options: PushSubscriptionStoreOptions = {}) {
    this.authority = options.authority;
    this.store = new PersistentStore<SubscriptionSnapshot>(filePath);
    this.lockPath = filePath === ':memory:' ? null : `${filePath}.writer.sqlite`;
    const policy = options.policy;
    this.policy = typeof policy === 'function'
      ? policy
      : ((): PushSubscriptionPolicy => policy ?? DEFAULT_PUSH_SUBSCRIPTION_POLICY);
    this.now = options.now ?? ((): number => Date.now());
  }

  private async loadSnapshot(): Promise<{
    raw: unknown[]; lastRemovals: Record<string, PushSubscriptionRemoval>; pending: PendingRevocation[]; principals: PendingPrincipalRevocation[];
  }> {
    const snapshot = await this.store.load();
    const raw = Array.isArray(snapshot?.subscriptions) ? [...snapshot.subscriptions] : [];
    const stored = snapshot?.lastRemovals;
    const lastRemovals = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
    return {
      raw, lastRemovals, pending: readPendingRevocations(snapshot?.pendingRevocations),
      principals: readPendingPrincipalRevocations(snapshot?.pendingPrincipalRevocations),
    };
  }

  /** Records from disk with the provably dead ones left out. A read never serves a dead record. */
  private async loadUsable(): Promise<StoredPushSubscription[]> {
    const { raw, pending, principals } = await this.loadSnapshot();
    const merged = this.withRecord(findDeadPushRecords(raw, this.policy(), this.now()).kept, pending);
    return [...merged.kept, ...merged.elsewhere].filter((record) => !revokedByPrincipal(record, principals));
  }

  /**
   * This file's records as the authority record has them: a record revoked
   * there (turned off, or proved dead, on any machine) is left out, and a
   * device registered through another machine of the group is added. A removal
   * made here that has not reached the record yet is left out too. An
   * unreadable record serves nothing: a device that may have been turned off
   * is never pushed to on a guess.
   */
  private withRecord(local: readonly StoredPushSubscription[], pending: readonly PendingRevocation[]): { kept: StoredPushSubscription[]; elsewhere: StoredPushSubscription[] } {
    const removedHere = new Set(pending.map((revocation) => revocation.id));
    const authority = this.authority;
    if (!authority) return { kept: local.filter((record) => !removedHere.has(record.id)), elsewhere: [] };
    const view = authority.view();
    if (!view) return { kept: [], elsewhere: [] };
    const kept = local.filter((record) => !removedHere.has(record.id) && !view.isRevoked(endpointKey(record.id)));
    const held = new Set(local.map((record) => record.id));
    const elsewhere: StoredPushSubscription[] = [];
    for (const entry of view.pushEndpoints()) {
      const sealed = entry.private;
      if (held.has(entry.id) || removedHere.has(entry.id) || !sealed) continue;
      elsewhere.push({
        id: entry.id,
        principalId: entry.public.principalId,
        ...(typeof entry.public.deviceId === 'string' ? { deviceId: entry.public.deviceId } : {}),
        endpoint: sealed.endpoint,
        keys: { p256dh: sealed.p256dh, auth: sealed.auth },
        createdAt: entry.public.createdAt,
      });
    }
    return { kept, elsewhere };
  }

  /**
   * Write registrations and removals to the authority record. Resolves true
   * when the record has them (or there is no record), false when the write
   * failed: the failure is logged, the change stands on this machine, and the
   * caller keeps any removal pending so the next write carries it.
   */
  private async publish(upserts: readonly StoredPushSubscription[], removals: readonly PendingRevocation[]): Promise<boolean> {
    const authority = this.authority;
    if (!authority || (upserts.length === 0 && removals.length === 0)) return true;
    // Already on the record as it stands: no write, no lock (the ordinary reconcile-on-open).
    const current = authority.view();
    if (current && removals.length === 0 && upserts.every((record) => {
      const entry = current.entry('push-endpoint', record.id);
      return entry !== null && (current.isRevoked(endpointKey(record.id)) || (entry.public.endpointHash === pushEndpointHash(record.endpoint)
        && entry.private?.p256dh === record.keys.p256dh && entry.private?.auth === record.keys.auth && entry.public.deviceId === record.deviceId));
    })) return true;
    try {
      await authority.write((view) => {
        const changes: AuthorityChange<null>[] = [];
        for (const record of upserts) {
          const key = endpointKey(record.id);
          const existing = view.entry('push-endpoint', record.id);
          const sealed = { endpoint: record.endpoint, p256dh: record.keys.p256dh, auth: record.keys.auth };
          const fields = {
            endpointHash: pushEndpointHash(record.endpoint),
            principalId: record.principalId,
            label: endpointOriginOf(record.endpoint),
            createdAt: record.createdAt,
            ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
          };
          if (!existing) {
            // A paired device's subscription is its child: revoking the device ends its pushes too.
            const device = pairingTokenIdOfPrincipal(record.principalId) ?? null;
            const parent: AuthorityKey | null = device && view.entry('device-token', device) ? `device-token:${device}` : null;
            changes.push({ kind: 'issue', value: null, entries: [{ kind: 'push-endpoint', id: record.id, parent, public: fields, private: sealed }] });
          } else if (!view.isRevoked(key) && (existing.public.endpointHash !== fields.endpointHash || existing.private?.p256dh !== sealed.p256dh
            || existing.private?.auth !== sealed.auth || existing.public.deviceId !== fields.deviceId)) {
            changes.push({ kind: 'update', key, patch: fields, narrowsOrWidens: false, privatePart: sealed, value: null });
          }
        }
        for (const removal of removals) {
          const existing = view.entry('push-endpoint', removal.id);
          if (existing && !existing.revoked) changes.push({ kind: 'revoke', key: endpointKey(removal.id), by: removal.by, reason: removal.reason, value: null });
        }
        return changes.length === 0 ? { kind: 'none', value: null } : { kind: 'many', changes, value: null };
      });
      return true;
    } catch (error) {
      if (removals.length > 0) {
        logger.warn('A push device removal is in force on this machine and is waiting to reach the other machines of the group: the authority record could not be written; the next write carries it', {
          error: String(error),
          waiting: removals.length,
        });
      } else {
        logger.warn('A push registration change could not be written to the authority record; it holds on this machine only until it is', { error: String(error) });
      }
      return false;
    }
  }

  /**
   * Run `fn` as the only read-modify-write against this file, in this process
   * and across processes. An in-memory store has no file to contend on and
   * takes the in-process chain only.
   */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> => {
      const lockPath = this.lockPath;
      return lockPath ? withProcessLock(lockPath, fn) : fn();
    };
    const next = this.queue.then(guarded, guarded);
    // Keep the chain alive after a rejection so one failure does not wedge the store.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Read the file for a write: the live records, the removal history, the
   * dead records this write drops along the way, and the removals still on
   * their way to the authority record. Throws AuthorityRecordUnavailableError
   * while the authority record exists but cannot be read: merged with an
   * unreadable record this file would hold nothing, and a write would empty it.
   */
  private async loadForWrite(): Promise<{
    records: StoredPushSubscription[];
    lastRemovals: Record<string, PushSubscriptionRemoval>;
    removed: PushSubscriptionRemoval[];
    /** Devices registered through another machine of the group, not in this file yet. */
    elsewhere: StoredPushSubscription[];
    pending: PendingRevocation[];
  }> {
    const authority = this.authority;
    if (authority && !authority.view()) throw new AuthorityRecordUnavailableError(authority.filePath);
    const { raw, lastRemovals, pending, principals } = await this.loadSnapshot();
    const now = this.now();
    const decision = findDeadPushRecords(raw, this.policy(), now);
    // A record the authority record holds as revoked is dropped from this file by this write.
    const merged = this.withRecord(decision.kept, pending);
    // A principal revoked while the record could not be read: its devices are named now, and this write revokes them.
    const withdrawn: PushSubscriptionRemoval[] = [];
    const notWithdrawn = (record: StoredPushSubscription): boolean => {
      const entry = revokedByPrincipal(record, principals);
      if (entry) withdrawn.push(removalOf(record, 'access-withdrawn', entry.evidence, now));
      return entry === undefined;
    };
    const records = merged.kept.filter(notWithdrawn);
    const elsewhere = merged.elsewhere.filter(notWithdrawn);
    return { records, lastRemovals, removed: [...decision.removed, ...withdrawn], elsewhere, pending };
  }

  /**
   * Write the records, noting and logging every removal this write carries.
   * The registrations in `upserts`, the removals (dead records, `revocations`
   * and every pending one) go to the authority record first; the file is
   * written after, keeping as pending the removals that did not reach it.
   */
  private async persist(
    records: readonly StoredPushSubscription[],
    lastRemovals: Record<string, PushSubscriptionRemoval>,
    removed: readonly PushSubscriptionRemoval[],
    pending: readonly PendingRevocation[],
    upserts: readonly StoredPushSubscription[] = [],
    revocations: readonly PendingRevocation[] = [],
  ): Promise<void> {
    for (const removal of removed) {
      lastRemovals[removal.principalId] = removal;
      logger.info('Push subscription removed', {
        subscriptionId: removal.subscriptionId,
        principalId: removal.principalId,
        endpointOrigin: removal.endpointOrigin,
        reason: removal.reason,
        evidence: removal.evidence,
      });
    }
    // A device proved dead, or turned off, here is dead on every machine of the group.
    const carried = mergeRevocations(
      pending,
      revocations,
      removed.map((removal) => ({ id: removal.subscriptionId, by: 'push-delivery', reason: `${removal.reason}: ${removal.evidence}` })),
    );
    const reached = await this.publish(upserts, carried);
    await this.store.persist({
      subscriptions: records,
      ...(Object.keys(lastRemovals).length > 0 ? { lastRemovals } : {}),
      ...(!reached && carried.length > 0 ? { pendingRevocations: carried } : {}),
    });
  }

  /**
   * Find the record this input reconciles onto: by device identity when the
   * input carries a deviceId (so a rotated endpoint heals in place), otherwise
   * by raw endpoint (the legacy, device-id-less path). A device id that matches
   * nothing still adopts the same principal's record for the same endpoint: it
   * is the same browser registering under a new identity (a client upgrade, or
   * cleared site storage), and a second record would send it every push twice.
   * Returns the index or -1.
   */
  private matchIndex(records: readonly StoredPushSubscription[], input: RegisterSubscriptionInput): number {
    if (input.deviceId !== undefined) {
      const byDevice = records.findIndex((r) => r.principalId === input.principalId && r.deviceId === input.deviceId);
      if (byDevice >= 0) return byDevice;
    }
    return records.findIndex((r) => r.principalId === input.principalId && r.endpoint === input.endpoint);
  }

  /**
   * Register (or refresh) a subscription. A record is reconciled on device
   * identity when the input carries a deviceId (a browser whose endpoint
   * rotated presents the same deviceId with a new endpoint, healing the one
   * record), otherwise on the raw endpoint (legacy). Either way a re-register
   * clears the failure counter, the client just proved the device is live.
   *
   * Throws `PushSubscriptionValidationError` when the endpoint or key material
   * could never receive a push.
   */
  async register(input: RegisterSubscriptionInput): Promise<StoredPushSubscription> {
    return (await this.reconcile(input)).record;
  }

  /**
   * Reconcile-on-open: store the client's CURRENT endpoint/keys for its device
   * identity, healing a stale record in place, and report what drifted so the
   * client learns whether the daemon had been holding an out-of-date endpoint.
   *
   * A registration is NEVER refused for crowding: above the warning threshold
   * the new device is accepted and the count is logged. Trading a working
   * device for a new one would silently stop notifications on a device nobody
   * unsubscribed.
   */
  async reconcile(input: RegisterSubscriptionInput): Promise<ReconcileResult> {
    assertUsableSubscription({ endpoint: input.endpoint, keys: input.keys });
    return this.run(async () => {
      const policy = this.policy();
      const { records, lastRemovals, removed, elsewhere, pending } = await this.loadForWrite();
      let existingIndex = this.matchIndex(records, input);
      // Registered through another machine of the group: the same device, under the same id.
      let adopted = false;
      if (existingIndex < 0) {
        const there = this.matchIndex(elsewhere, input);
        if (there >= 0) {
          records.push(elsewhere[there] as StoredPushSubscription);
          existingIndex = records.length - 1;
          adopted = true;
        }
      }
      let mergedDuplicates = false;
      if (existingIndex >= 0) {
        // Another record of this principal already holding the endpoint this one
        // is moving to would receive every push twice; the device is one device.
        const endpointHolders = records.filter((r, i) => i !== existingIndex && r.principalId === input.principalId && r.endpoint === input.endpoint);
        if (endpointHolders.length > 0) {
          const survivor = records[existingIndex] as StoredPushSubscription;
          const kept = records.filter((r) => !endpointHolders.includes(r));
          records.splice(0, records.length, ...kept);
          existingIndex = records.indexOf(survivor);
          mergedDuplicates = true;
        }
        const prior = records[existingIndex] as StoredPushSubscription;
        const endpointChanged = prior.endpoint !== input.endpoint;
        const keysChanged = prior.keys.p256dh !== input.keys.p256dh || prior.keys.auth !== input.keys.auth;
        const deviceIdAdopted = input.deviceId !== undefined && prior.deviceId !== input.deviceId;
        if (!endpointChanged && !keysChanged && !deviceIdAdopted && !mergedDuplicates && !adopted
          && (prior.consecutiveFailures ?? 0) === 0 && removed.length === 0) {
          // The record may not have it yet (an earlier write to it failed): say so there now,
          // with any removal still waiting to reach it.
          if (pending.length === 0) await this.publish([prior], []);
          else await this.persist(records, lastRemovals, [], pending, [prior]);
          return { record: prior, drift: 'unchanged' };
        }
        const updated: StoredPushSubscription = {
          ...prior,
          endpoint: input.endpoint,
          keys: input.keys,
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
          // A live client resets the rejection counter.
          consecutiveFailures: 0,
        };
        records[existingIndex] = updated;
        await this.persist(records, lastRemovals, removed, pending, [updated]);
        const drift: PushReconcileDrift = endpointChanged
          ? 'endpoint-updated'
          : keysChanged
            ? 'keys-updated'
            : 'unchanged';
        return { record: updated, drift };
      }
      const record: StoredPushSubscription = {
        id: `push-${randomUUID()}`,
        principalId: input.principalId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        endpoint: input.endpoint,
        keys: input.keys,
        createdAt: this.now(),
      };
      records.push(record);
      await this.persist(records, lastRemovals, removed, pending, [record]);
      const held = records.filter((r) => r.principalId === input.principalId).length;
      if (held > policy.warnAbovePerPrincipal) {
        logger.warn('Push subscriptions above the per-principal warning threshold', {
          principalId: input.principalId,
          held,
          warnAbove: policy.warnAbovePerPrincipal,
          note: 'accepted anyway, no working subscription is ever removed to make room',
        });
      }
      return { record, drift: 'created' };
    });
  }

  /** All subscriptions for a principal, redacted for the wire. */
  async listPublic(principalId: string): Promise<PublicPushSubscription[]> {
    return (await this.status(principalId)).subscriptions;
  }

  /** A principal's devices and the latest removal among them, from one read. */
  async status(principalId: string): Promise<PushSubscriptionStatus> {
    const { raw, lastRemovals, pending, principals } = await this.loadSnapshot();
    const now = this.now();
    const decision = findDeadPushRecords(raw, this.policy(), now);
    // A record that is dead but not yet dropped by a write is already gone for
    // every reader, so it is reported as the removal it is about to be.
    let lastRemoval = lastRemovals[principalId];
    for (const pending of decision.removed) {
      if (pending.principalId === principalId) lastRemoval = pending;
    }
    const merged = this.withRecord(decision.kept, pending);
    return {
      subscriptions: [...merged.kept, ...merged.elsewhere]
        .filter((r) => r.principalId === principalId && !revokedByPrincipal(r, principals)).map(toPublicSubscription),
      ...(lastRemoval ? { lastRemoval } : {}),
    };
  }

  /** The full record (endpoint + keys) for a delivery. Not for the wire. */
  async get(id: string): Promise<StoredPushSubscription | null> {
    const records = await this.loadUsable();
    return records.find((r) => r.id === id) ?? null;
  }

  /** Every stored subscription, the delivery fan-out reads this. Not for the wire. */
  async all(): Promise<readonly StoredPushSubscription[]> {
    return this.loadUsable();
  }

  /**
   * Delete a subscription. Returns true if a record was actually removed, false
   * if the id was already absent, the caller reports an honest 404 rather than
   * a 200-noop. An optional `principalId` scopes the delete so one operator
   * cannot remove another's device.
   */
  async remove(id: string, principalId?: string): Promise<boolean> {
    return this.run(async () => {
      const { records, lastRemovals, removed, elsewhere, pending } = await this.loadForWrite();
      const matches = (r: StoredPushSubscription): boolean => r.id === id && (principalId === undefined || r.principalId === principalId);
      const index = records.findIndex(matches);
      const there = index < 0 ? elsewhere.find(matches) : undefined;
      if (index < 0 && !there) {
        if (removed.length > 0 || pending.length > 0) await this.persist(records, lastRemovals, removed, pending);
        return false;
      }
      const target = index >= 0 ? records[index] as StoredPushSubscription : there!;
      if (index >= 0) records.splice(index, 1);
      // Turned off by its owner: revoked on the authority record, so no machine of the group pushes to it again.
      await this.persist(records, lastRemovals, removed, pending, [], [{ id: target.id, by: target.principalId, reason: 'turned off by its owner' }]);
      return true;
    });
  }

  /**
   * Revoke every endpoint `principalId` registered, here and on the authority
   * record (so no machine of the group pushes to them again), in one write,
   * with `reason` recorded as the principal's last removal so
   * push.subscriptions.list says why. Resolves to how many were removed.
   *
   * While the authority record exists but cannot be read, the devices it holds
   * cannot all be named: the revocation of the principal is kept in this file
   * instead, no read here serves those devices from then on, and the next write
   * that can read the record revokes each of them there. Resolves to how many
   * of this file's records it covers.
   */
  async revokePrincipal(principalId: string, evidence: string): Promise<number> {
    return this.run(async () => {
      const authority = this.authority;
      if (authority && !authority.view()) {
        const snapshot = await this.store.load();
        const at = this.now();
        const principals = [...readPendingPrincipalRevocations(snapshot?.pendingPrincipalRevocations).filter((entry) => entry.principalId !== principalId),
          { principalId, evidence, at }];
        await this.store.persist({ ...(snapshot ?? { subscriptions: [] }), pendingPrincipalRevocations: principals });
        logger.warn('The push devices of a user who lost admin access are no longer served here; the authority record cannot be read, so the next write that can read it revokes them on every machine of the group', {
          principalId,
        });
        const raw = Array.isArray(snapshot?.subscriptions) ? snapshot.subscriptions : [];
        return raw.filter((record) => (record as Partial<StoredPushSubscription> | null)?.principalId === principalId).length;
      }
      const { records, lastRemovals, removed, elsewhere, pending } = await this.loadForWrite();
      const targets = [...records, ...elsewhere].filter((record) => record.principalId === principalId);
      if (targets.length === 0) {
        if (removed.length > 0 || pending.length > 0) await this.persist(records, lastRemovals, removed, pending);
        return 0;
      }
      const kept = records.filter((record) => record.principalId !== principalId);
      const now = this.now();
      // persist() records each removal and revokes it on the authority record in its one publish.
      await this.persist(kept, lastRemovals, [...removed, ...targets.map((record) => removalOf(record, 'access-withdrawn', evidence, now))], pending);
      return targets.length;
    });
  }

  /**
   * Stamp the outcomes of one delivery attempt (one device, or a whole fan-out)
   * in one write. A `gone` stamp removes its record; a `rejected` stamp counts
   * toward `failureThreshold` and removes the record at the bound; `unproven`
   * records the attempt and leaves the count alone; `delivered` resets it. A
   * stamp for a record that is no longer stored is ignored.
   */
  async applyOutcomes(
    stamps: readonly PushOutcomeStamp[],
    failureThreshold: number,
  ): Promise<ReadonlyMap<string, AppliedPushOutcome>> {
    const applied = new Map<string, AppliedPushOutcome>();
    if (stamps.length === 0) return applied;
    return this.run(async () => {
      const now = this.now();
      const { records, lastRemovals, removed, elsewhere, pending } = await this.loadForWrite();
      const byId = new Map(stamps.map((stamp) => [stamp.subscriptionId, stamp]));
      // A device registered through another machine that this machine pushed to: its outcomes are kept here from now on.
      for (const record of elsewhere) if (byId.has(record.id)) records.push(record);
      const kept: StoredPushSubscription[] = [];
      for (const prior of records) {
        const stamp = byId.get(prior.id);
        if (!stamp) {
          kept.push(prior);
          continue;
        }
        if (stamp.endpoint !== prior.endpoint) {
          // The device registered a new endpoint while this attempt was out:
          // what the push service said about the old one says nothing here.
          kept.push(prior);
          applied.set(prior.id, { consecutiveFailures: prior.consecutiveFailures ?? 0, superseded: true });
          continue;
        }
        if (stamp.evidence === 'gone') {
          const removal = removalOf(prior, 'gone', stamp.detail, now);
          removed.push(removal);
          applied.set(prior.id, { consecutiveFailures: prior.consecutiveFailures ?? 0, removed: removal });
          continue;
        }
        const consecutiveFailures = stamp.evidence === 'delivered'
          ? 0
          : stamp.evidence === 'rejected'
            ? (prior.consecutiveFailures ?? 0) + 1
            : (prior.consecutiveFailures ?? 0);
        if (stamp.evidence === 'rejected' && consecutiveFailures >= failureThreshold) {
          const removal = removalOf(
            prior,
            'failure-threshold',
            `${stamp.detail}; the push service rejected ${consecutiveFailures} consecutive deliveries (bound ${failureThreshold})`,
            now,
          );
          removed.push(removal);
          applied.set(prior.id, { consecutiveFailures, removed: removal });
          continue;
        }
        kept.push({
          ...prior,
          lastDeliveryAt: now,
          lastOutcome: stamp.evidence === 'delivered' ? 'delivered' : 'failed',
          consecutiveFailures,
        });
        applied.set(prior.id, { consecutiveFailures });
      }
      await this.persist(kept, lastRemovals, removed, pending);
      return applied;
    });
  }
}

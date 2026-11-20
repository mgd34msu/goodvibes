/**
 * push/subscription-store.ts
 *
 * The on-disk record of which devices an operator has registered for browser
 * push. Persisted with the same atomic-JSON `PersistentStore` the approval and
 * session stores use, the capability URLs and key material stay on disk in the
 * daemon's own state directory, never on the wire.
 *
 * Delete means delete: `remove()` drops the record entirely (it does not flag a
 * tombstone), and `list()` cannot return it afterward.
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
import type { AuthorityChange, AuthorityRecordFile } from '../cluster/authority-record-file.js';
import type { AuthorityKey } from '../cluster/authority-record.js';
import { withProcessLock } from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';
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

  private async loadSnapshot(): Promise<{ raw: unknown[]; lastRemovals: Record<string, PushSubscriptionRemoval> }> {
    const snapshot = await this.store.load();
    const raw = Array.isArray(snapshot?.subscriptions) ? [...snapshot.subscriptions] : [];
    const stored = snapshot?.lastRemovals;
    const lastRemovals = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
    return { raw, lastRemovals };
  }

  /** Records from disk with the provably dead ones left out. A read never serves a dead record. */
  private async loadUsable(): Promise<StoredPushSubscription[]> {
    const merged = this.withRecord(findDeadPushRecords((await this.loadSnapshot()).raw, this.policy(), this.now()).kept);
    return [...merged.kept, ...merged.elsewhere];
  }

  /**
   * This file's records as the authority record has them: a record revoked
   * there (turned off, or proved dead, on any machine) is left out, and a
   * device registered through another machine of the group is added. An
   * unreadable record serves nothing: a device that may have been turned off
   * is never pushed to on a guess.
   */
  private withRecord(local: readonly StoredPushSubscription[]): { kept: StoredPushSubscription[]; elsewhere: StoredPushSubscription[] } {
    const authority = this.authority;
    if (!authority) return { kept: [...local], elsewhere: [] };
    const view = authority.view();
    if (!view) return { kept: [], elsewhere: [] };
    const kept = local.filter((record) => !view.isRevoked(endpointKey(record.id)));
    const held = new Set(local.map((record) => record.id));
    const elsewhere: StoredPushSubscription[] = [];
    for (const entry of view.pushEndpoints()) {
      const sealed = entry.private;
      if (held.has(entry.id) || !sealed) continue;
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
   * Write registrations and removals to the authority record. A failure is
   * logged: the change stands on this machine, and the next write carries it.
   */
  private async publish(upserts: readonly StoredPushSubscription[], removals: readonly { readonly id: string; readonly by: string; readonly reason: string }[]): Promise<void> {
    const authority = this.authority;
    if (!authority || (upserts.length === 0 && removals.length === 0)) return;
    // Already on the record as it stands: no write, no lock (the ordinary reconcile-on-open).
    const current = authority.view();
    if (current && removals.length === 0 && upserts.every((record) => {
      const entry = current.entry('push-endpoint', record.id);
      return entry !== null && (current.isRevoked(endpointKey(record.id)) || (entry.public.endpointHash === pushEndpointHash(record.endpoint)
        && entry.private?.p256dh === record.keys.p256dh && entry.private?.auth === record.keys.auth && entry.public.deviceId === record.deviceId));
    })) return;
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
            const device = record.principalId.startsWith('pairing:') ? record.principalId.slice('pairing:'.length) : null;
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
    } catch (error) {
      logger.warn('A push registration change could not be written to the authority record; it holds on this machine only until it is', { error: String(error) });
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
   * Read the file for a write: the live records, the removal history, and the
   * dead records this write drops along the way.
   */
  private async loadForWrite(): Promise<{
    records: StoredPushSubscription[];
    lastRemovals: Record<string, PushSubscriptionRemoval>;
    removed: PushSubscriptionRemoval[];
    /** Devices registered through another machine of the group, not in this file yet. */
    elsewhere: StoredPushSubscription[];
  }> {
    const { raw, lastRemovals } = await this.loadSnapshot();
    const decision = findDeadPushRecords(raw, this.policy(), this.now());
    // A record the authority record holds as revoked is dropped from this file by this write.
    const merged = this.withRecord(decision.kept);
    return { records: merged.kept, lastRemovals, removed: decision.removed, elsewhere: merged.elsewhere };
  }

  /** Write the records, noting and logging every removal this write carries. */
  private async persist(
    records: readonly StoredPushSubscription[],
    lastRemovals: Record<string, PushSubscriptionRemoval>,
    removed: readonly PushSubscriptionRemoval[],
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
    await this.store.persist({
      subscriptions: records,
      ...(Object.keys(lastRemovals).length > 0 ? { lastRemovals } : {}),
    });
    // A device proved dead, or turned off, here is dead on every machine of the group.
    await this.publish([], removed.map((removal) => ({ id: removal.subscriptionId, by: 'push-delivery', reason: `${removal.reason}: ${removal.evidence}` })));
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
      const { records, lastRemovals, removed, elsewhere } = await this.loadForWrite();
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
          // The record may not have it yet (an earlier write to it failed): say so there now.
          await this.publish([prior], []);
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
        await this.persist(records, lastRemovals, removed);
        await this.publish([updated], []);
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
      await this.persist(records, lastRemovals, removed);
      await this.publish([record], []);
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
    const { raw, lastRemovals } = await this.loadSnapshot();
    const now = this.now();
    const decision = findDeadPushRecords(raw, this.policy(), now);
    // A record that is dead but not yet dropped by a write is already gone for
    // every reader, so it is reported as the removal it is about to be.
    let lastRemoval = lastRemovals[principalId];
    for (const pending of decision.removed) {
      if (pending.principalId === principalId) lastRemoval = pending;
    }
    const merged = this.withRecord(decision.kept);
    return {
      subscriptions: [...merged.kept, ...merged.elsewhere].filter((r) => r.principalId === principalId).map(toPublicSubscription),
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
      const { records, lastRemovals, removed, elsewhere } = await this.loadForWrite();
      const matches = (r: StoredPushSubscription): boolean => r.id === id && (principalId === undefined || r.principalId === principalId);
      const index = records.findIndex(matches);
      const there = index < 0 ? elsewhere.find(matches) : undefined;
      if (index < 0 && !there) {
        if (removed.length > 0) await this.persist(records, lastRemovals, removed);
        return false;
      }
      const target = index >= 0 ? records[index] as StoredPushSubscription : there!;
      if (index >= 0) records.splice(index, 1);
      // Turned off by its owner: revoked on the authority record, so no machine of the group pushes to it again.
      await this.persist(records, lastRemovals, removed);
      await this.publish([], [{ id: target.id, by: target.principalId, reason: 'turned off by its owner' }]);
      return true;
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
      const { records, lastRemovals, removed, elsewhere } = await this.loadForWrite();
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
      await this.persist(kept, lastRemovals, removed);
      return applied;
    });
  }
}

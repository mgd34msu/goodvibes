/**
 * device-grants.ts, durable "always allow" grants for paired-device capabilities.
 *
 * The owner's ruling (2026-07-25): "'always allow' is OFFERED on every
 * capability, including front camera, screen capture, precise location, and
 * clipboard, as a durable per-capability, per-node grant, visible and
 * revocable in the grants surface."
 *
 * The grants themselves live on the authority record
 * (cluster/authority-record.ts), as `device-grant` entries: the one answer, on
 * this machine and on every machine of its group, to whether a grant is
 * current. A grant made on one machine is in force on every machine; a
 * revocation is a terminal record entry, so it holds on every machine, after a
 * restart, and on a machine that was away when it was made. Nothing on this
 * machine keeps a second copy that could say yes.
 *
 * A live grant is the whole authority for a request: it runs with no question
 * and no model call. If no live, unexpired, unrevoked grant is found, the
 * capability service lets `permissions.mode` decide (the owner is asked, except
 * under yolo). A lookup is a read of the record's view (one lstat, no file
 * read unless the record moved), and work admitted under a grant keeps a
 * reference to it, checked again when the phone picks the work up.
 *
 * What stays on this machine, in `device-grants.json`, is bookkeeping that is
 * not authority: when each grant was last used and how often, and the audit
 * ledger the grants surface renders.
 *
 * Housekeeping, since grants are persisted state:
 *  1. Reap on recovery: grants for a node that no longer exists, and
 *     session-scoped grants whose session is gone, are revoked at start.
 *  2. Bound everything: per-node count cap AND an age TTL; the audit ledger
 *     has its own cap and TTL.
 *  3. Validate by content: a record entry whose fields do not parse, or whose
 *     capability is not in the catalog, is never honoured, and is revoked.
 *  4. Reap periodically: `sweep()` is safe to call on a timer, not only at boot.
 *  5. Disclose what was reaped: every sweep returns an itemised report, and
 *     the removals are appended to the audit ledger.
 *
 * Sweeps are idempotent and safe on every machine at once: each judges the
 * record it reads, picks the same grants to remove, and a revocation written
 * twice keeps the first.
 */
import { randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.js';
import { withProcessLock } from '../utils/process-lock.js';
import type { AuthorityChange, AuthorityRecordFile } from '../cluster/authority-record-file.js';
import type { AuthorityEntry, AuthorityKey, AuthorityRevocation, AuthorityView } from '../cluster/authority-record.js';
import { isDeviceCapabilityId, type DeviceCapabilityId, type DeviceNodeKind } from './device-capability-contract.js';
import { resolveDevicePolicySource, type DevicePolicySource } from './device-policy-source.js';

/** Scope of an approval a person gave. */
export type DeviceGrantScope = 'always' | 'session';

/** A durable per-capability, per-node approval. */
export interface DeviceCapabilityGrant {
  readonly id: string;
  readonly nodeId: string;
  readonly nodeKind: DeviceNodeKind;
  readonly capabilityId: DeviceCapabilityId;
  readonly scope: DeviceGrantScope;
  /** Present only for session-scoped grants; reaped when the session is gone. */
  readonly sessionId?: string | undefined;
  readonly grantedAt: number;
  /** Age TTL. Every grant has one, nothing is granted forever. */
  readonly expiresAt: number;
  readonly lastUsedAt?: number | undefined;
  readonly useCount: number;
  /** Who approved it (operator id / surface actor). */
  readonly grantedBy: string;
  /**
   * The record revision of the grant's last narrowing or widening. Work
   * admitted under the grant carries it, and is current only while the grant
   * is live at this revision.
   */
  readonly authorityRev: number;
}

/** Why a grant left the store. */
export type DeviceGrantRemovalReason =
  | 'revoked'
  | 'expired'
  | 'node-gone'
  | 'session-gone'
  | 'malformed'
  | 'per-node-cap'
  | 'total-cap';

/** One removal, itemised for disclosure. */
export interface DeviceGrantRemoval {
  readonly grantId: string;
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly scope: string;
  readonly reason: DeviceGrantRemovalReason;
  readonly removedAt: number;
  readonly note?: string | undefined;
}

/** Bounded ledger entry so a surface can show what happened and why. */
export interface DeviceGrantAuditRecord {
  readonly id: string;
  readonly action: 'granted' | 'used' | 'removed';
  readonly grantId: string;
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly at: number;
  readonly actor: string;
  readonly reason?: string | undefined;
}

interface DeviceGrantUsage {
  readonly lastUsedAt: number;
  readonly useCount: number;
}

/** This machine's bookkeeping beside the record: use counts and the audit ledger. */
interface DeviceGrantSnapshot extends Record<string, unknown> {
  readonly version: 2;
  readonly usage: Readonly<Record<string, DeviceGrantUsage>>;
  readonly audit: readonly DeviceGrantAuditRecord[];
}

/** Result of one housekeeping pass over the grants. */
export interface DeviceGrantSweepReport {
  readonly sweptAt: number;
  readonly removed: readonly DeviceGrantRemoval[];
  readonly retained: number;
  readonly auditTrimmed: number;
}

export interface DeviceGrantPolicy {
  /** Age TTL applied when a grant is recorded. */
  readonly grantTtlMs: number;
  /** Count cap per node; oldest grants past the cap are reaped. */
  readonly maxGrantsPerNode: number;
  /** Absolute count cap across all nodes. */
  readonly maxGrantsTotal: number;
  /** Age TTL for the audit ledger's `used` entries (grants and removals are kept for good). */
  readonly auditRetentionMs: number;
  /** Count cap for the audit ledger's `used` entries. */
  readonly maxAuditRecords: number;
}

export const DEFAULT_DEVICE_GRANT_POLICY: DeviceGrantPolicy = {
  grantTtlMs: 90 * 24 * 60 * 60 * 1000,
  maxGrantsPerNode: 64,
  maxGrantsTotal: 512,
  auditRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxAuditRecords: 500,
};

/**
 * Liveness probes the sweep uses to decide whether a grant's owner still
 * exists. Both default to "still there" so a caller that cannot answer never
 * causes silent data loss.
 */
export interface DeviceGrantOwnership {
  readonly isKnownNode?: ((nodeId: string) => boolean) | undefined;
  readonly isActiveSession?: ((sessionId: string) => boolean) | undefined;
}

export interface DeviceGrantStoreOptions {
  /** The authority record the grants live on. */
  readonly authority: AuthorityRecordFile;
  /**
   * Fixed bounds, or a resolver read at every use so a live settings change
   * applies without a restart (see device-policy-source.ts).
   */
  readonly policy?: DevicePolicySource<DeviceGrantPolicy> | undefined;
  readonly now?: (() => number) | undefined;
  readonly ownership?: DeviceGrantOwnership | undefined;
}

/** How long a write waits for another process's write to the same ledger. */
const GRANT_LOCK_TIMEOUT_MS = 10_000;

const EMPTY_SNAPSHOT: DeviceGrantSnapshot = { version: 2, usage: {}, audit: [] };

const grantKey = (id: string): AuthorityKey => `device-grant:${id}`;

/**
 * A record entry as a grant, validated by its content: a field that does not
 * parse, or a capability that no longer exists, is never honoured.
 */
function grantFromEntry(entry: AuthorityEntry<'device-grant'>): DeviceCapabilityGrant | null {
  const fields = entry.public as Readonly<Record<string, unknown>>;
  const nodeId = typeof fields['nodeId'] === 'string' ? fields['nodeId'].trim() : '';
  const nodeKind = typeof fields['nodeKind'] === 'string' ? fields['nodeKind'].trim() : '';
  const grantedBy = typeof fields['grantedBy'] === 'string' ? fields['grantedBy'].trim() : '';
  const capabilityId = fields['capabilityId'];
  const scope = fields['scope'];
  const expiresAt = fields['expiresAt'];
  if (!nodeId || !nodeKind || !grantedBy || !isDeviceCapabilityId(capabilityId)) return null;
  if (scope !== 'always' && scope !== 'session') return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  const sessionId = typeof fields['sessionId'] === 'string' && fields['sessionId'].trim() ? fields['sessionId'].trim() : undefined;
  if (scope === 'session' && !sessionId) return null;
  const grantedAt = typeof fields['grantedAt'] === 'number' && Number.isFinite(fields['grantedAt']) ? fields['grantedAt'] : entry.at;
  return {
    id: entry.id,
    nodeId,
    nodeKind,
    capabilityId,
    scope,
    ...(sessionId ? { sessionId } : {}),
    grantedAt,
    expiresAt,
    useCount: 0,
    grantedBy,
    authorityRev: entry.authorityRev,
  };
}

function validateUsage(value: unknown): Record<string, DeviceGrantUsage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const usage: Record<string, DeviceGrantUsage> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.lastUsedAt !== 'number' || !Number.isFinite(record.lastUsedAt)) continue;
    if (typeof record.useCount !== 'number' || !Number.isInteger(record.useCount) || record.useCount < 0) continue;
    usage[id] = { lastUsedAt: record.lastUsedAt, useCount: record.useCount };
  }
  return usage;
}

function validateAudit(value: unknown): DeviceGrantAuditRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const action = record.action;
  if (action !== 'granted' && action !== 'used' && action !== 'removed') return null;
  const id = typeof record.id === 'string' ? record.id : '';
  const at = record.at;
  if (!id || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return {
    id,
    action,
    grantId: typeof record.grantId === 'string' ? record.grantId : '',
    nodeId: typeof record.nodeId === 'string' ? record.nodeId : '',
    capabilityId: typeof record.capabilityId === 'string' ? record.capabilityId : '',
    at,
    actor: typeof record.actor === 'string' ? record.actor : 'unknown',
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  };
}

/** One live grant on the record, with the entry it came from. */
interface LiveGrant {
  readonly grant: DeviceCapabilityGrant;
  readonly entry: AuthorityEntry<'device-grant'>;
}

/**
 * Durable grants on the authority record, with this machine's use counts and
 * audit ledger beside it.
 */
/** A revoke named a grant id the authority record has never held (a mistyped or made-up id). */
export class DeviceGrantNotFoundError extends Error {
  readonly code = 'GRANT_NOT_FOUND';
  readonly status = 404;
  constructor(readonly grantId: string) {
    super(`No grant ${grantId} was ever recorded. Nothing was revoked. Read devices.grants.list for the grant ids.`);
    this.name = 'DeviceGrantNotFoundError';
  }
}

export class DeviceGrantStore {
  private readonly store: PersistentStore<DeviceGrantSnapshot>;
  private readonly authority: AuthorityRecordFile;
  private readonly resolvePolicy: () => DeviceGrantPolicy;
  private readonly now: () => number;
  private readonly ownership: DeviceGrantOwnership;
  private writeChain: Promise<void> = Promise.resolve();
  /** Kernel-released writer lock beside the ledger; null for an in-memory store. */
  private readonly writerLockPath: string | null;

  constructor(storeOrPath: PersistentStore<DeviceGrantSnapshot> | string, options: DeviceGrantStoreOptions) {
    this.store = typeof storeOrPath === 'string'
      ? new PersistentStore<DeviceGrantSnapshot>(storeOrPath)
      : storeOrPath;
    const lock = this.store.lockPath;
    this.writerLockPath = lock ? `${lock.slice(0, -'.lock'.length)}.writer.sqlite` : null;
    this.authority = options.authority;
    this.resolvePolicy = resolveDevicePolicySource(options.policy, DEFAULT_DEVICE_GRANT_POLICY);
    this.now = options.now ?? (() => Date.now());
    this.ownership = options.ownership ?? {};
  }

  /**
   * The bounds in force right now. With a resolver this re-reads the live
   * configuration, so a caller rendering the policy shows what the next sweep
   * will actually apply.
   */
  getPolicy(): DeviceGrantPolicy {
    return this.resolvePolicy();
  }

  /**
   * Grant entries this machine answers for: not revoked (itself or through a
   * parent), meant for this machine, and parsing as a grant. `malformed` are
   * the live entries that do not parse.
   */
  private liveOnRecord(view: AuthorityView): { live: LiveGrant[]; malformed: AuthorityEntry<'device-grant'>[] } {
    const live: LiveGrant[] = [];
    const malformed: AuthorityEntry<'device-grant'>[] = [];
    for (const entry of view.list('device-grant')) {
      if (view.isRevoked(grantKey(entry.id))) continue;
      if (entry.audience !== 'group' && entry.audience.nodeId !== view.nodeId) continue;
      const grant = grantFromEntry(entry);
      if (grant) live.push({ grant, entry });
      else malformed.push(entry);
    }
    return { live, malformed };
  }

  private async readLedger(): Promise<DeviceGrantSnapshot> {
    const raw = await this.store.load();
    if (!raw || typeof raw !== 'object') return EMPTY_SNAPSHOT;
    const audit = Array.isArray(raw.audit)
      ? raw.audit.map(validateAudit).filter((entry): entry is DeviceGrantAuditRecord => entry !== null)
      : [];
    return { version: 2, usage: validateUsage(raw.usage), audit };
  }

  /**
   * Serialise ledger writes within this process, and across processes (a
   * daemon and the one taking over from it) by holding the writer lock around
   * the whole read-modify-write. The lock is released by the kernel when its
   * holder exits, so a killed process leaves nothing stale.
   */
  private async mutateLedger(fn: (snapshot: DeviceGrantSnapshot) => DeviceGrantSnapshot): Promise<void> {
    const cycle = async (): Promise<void> => {
      const snapshot = await this.readLedger();
      const next = fn(snapshot);
      if (next !== snapshot) await this.store.persist(next);
    };
    const lock = this.writerLockPath;
    const run = this.writeChain.then(() => (lock ? withProcessLock(lock, cycle, { waitMs: GRANT_LOCK_TIMEOUT_MS }) : cycle()));
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Every live grant on the record, unexpired, with this machine's use
   * counts. An unreadable record lists nothing: no grant is shown as live
   * that could not be checked.
   */
  async list(): Promise<readonly DeviceCapabilityGrant[]> {
    const view = this.authority.view();
    if (!view) return [];
    const now = this.now();
    const { usage } = await this.readLedger();
    return this.liveOnRecord(view).live
      .filter(({ grant }) => grant.expiresAt > now)
      .map(({ grant }) => {
        const used = usage[grant.id];
        return used ? { ...grant, lastUsedAt: used.lastUsedAt, useCount: used.useCount } : grant;
      });
  }

  /** The audit ledger, newest last. */
  async listAudit(limit = 100): Promise<readonly DeviceGrantAuditRecord[]> {
    const snapshot = await this.readLedger();
    return snapshot.audit.slice(-Math.max(1, limit));
  }

  /**
   * Find a live grant authorising this capability on this node, or null.
   *
   * Null for anything revoked (on any machine of the group), expired, or
   * scoped to a session that is no longer active, and while the record cannot
   * be read: a grant that could not be checked is never honoured. A read of
   * the record's view; no file is read unless the record moved.
   */
  async find(input: {
    readonly nodeId: string;
    readonly capabilityId: DeviceCapabilityId;
    readonly sessionId?: string | undefined;
  }): Promise<DeviceCapabilityGrant | null> {
    const view = this.authority.view();
    if (!view) return null;
    const now = this.now();
    for (const { grant } of this.liveOnRecord(view).live) {
      if (grant.nodeId !== input.nodeId || grant.capabilityId !== input.capabilityId || grant.expiresAt <= now) continue;
      if (grant.scope === 'session') {
        if (!input.sessionId || grant.sessionId !== input.sessionId) continue;
        if (this.ownership.isActiveSession && !this.ownership.isActiveSession(grant.sessionId!)) continue;
      }
      return grant;
    }
    return null;
  }

  /**
   * Whether work admitted under `grant` may still run: the grant is live on
   * the record at the revision it was admitted under, and unexpired. A map
   * read; an unreadable record answers no.
   */
  isCurrent(grant: Pick<DeviceCapabilityGrant, 'id' | 'authorityRev' | 'expiresAt'>): boolean {
    const view = this.authority.view();
    if (!view || grant.expiresAt <= this.now()) return false;
    return view.isCurrent({ key: grantKey(grant.id), authorityRev: grant.authorityRev });
  }

  /** How a grant stopped being current, in words for a refusal; null when it is current or unknown. */
  describeEnd(grant: Pick<DeviceCapabilityGrant, 'id' | 'authorityRev' | 'expiresAt'>): string | null {
    const view = this.authority.view();
    if (!view) return 'the authority record could not be read';
    if (grant.expiresAt <= this.now()) return 'it expired';
    const entry = view.entry('device-grant', grant.id);
    if (!entry) return null;
    const revocation: AuthorityRevocation | null = entry.revoked;
    if (revocation) {
      return `it was revoked at record revision ${revocation.rev} by ${revocation.by || 'an operator'} on node ${revocation.origin}${revocation.reason ? ` (${revocation.reason})` : ''}`;
    }
    if (view.isRevoked(grantKey(grant.id))) return 'what it rested on was revoked';
    if (entry.authorityRev !== grant.authorityRev) return `it was changed at record revision ${entry.authorityRev}`;
    return null;
  }

  /**
   * Call `listener` whenever the record changes (on this machine, in another
   * process of this home, or merged from another machine); the caller checks
   * {@link isCurrent} for the grants it holds. Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void {
    return this.authority.onChange((notice) => {
      if (notice.keys.some((key) => key.startsWith('device-grant:')) || notice.cascade.length > 0 || !notice.local) listener();
    });
  }

  /**
   * Record an approval on the authority record. Granting an existing pair
   * again refreshes it (its expiry and who approved it) rather than adding a
   * second grant; work admitted under it stays current.
   */
  async record(input: {
    readonly nodeId: string;
    readonly nodeKind: DeviceNodeKind;
    readonly capabilityId: DeviceCapabilityId;
    readonly scope: DeviceGrantScope;
    readonly sessionId?: string | undefined;
    readonly grantedBy: string;
    readonly ttlMs?: number | undefined;
  }): Promise<DeviceCapabilityGrant> {
    const now = this.now();
    const ttl = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : this.getPolicy().grantTtlMs;
    const fields = {
      nodeId: input.nodeId,
      nodeKind: input.nodeKind,
      capabilityId: input.capabilityId,
      scope: input.scope,
      sessionId: input.sessionId ?? null,
      expiresAt: now + ttl,
      grantedBy: input.grantedBy,
      grantedAt: now,
    };
    const written = await this.authority.write((view) => {
      const existing = this.liveOnRecord(view).live.find(({ grant }) => grant.nodeId === input.nodeId
        && grant.capabilityId === input.capabilityId && grant.scope === input.scope && grant.sessionId === input.sessionId);
      if (existing) {
        return { kind: 'update', key: grantKey(existing.grant.id), patch: fields, narrowsOrWidens: false, value: existing.grant.id };
      }
      const id = randomUUID();
      return {
        kind: 'issue',
        value: id,
        entries: [{
          kind: 'device-grant',
          id,
          // A session grant is good where its session is; an "always" grant on every machine of the group.
          audience: input.scope === 'session' ? { nodeId: view.nodeId } : 'group',
          public: fields,
        }],
      };
    });
    const entry = this.authority.view()?.entry('device-grant', written.value);
    const grant = entry ? grantFromEntry(entry) : null;
    if (!grant) throw new Error('The device grant was written to the authority record but could not be read back.');
    await this.mutateLedger((snapshot) => ({
      version: 2,
      usage: snapshot.usage,
      audit: [...snapshot.audit, {
        id: randomUUID(),
        action: 'granted',
        grantId: grant.id,
        nodeId: grant.nodeId,
        capabilityId: grant.capabilityId,
        at: now,
        actor: input.grantedBy,
        reason: `always-allow (${input.scope})`,
      }],
    }));
    return grant;
  }

  /** Note a use of a grant (drives "last used" in the grants surface). Bookkeeping on this machine only. */
  async markUsed(grantId: string): Promise<void> {
    const now = this.now();
    const entry = this.authority.view()?.entry('device-grant', grantId);
    const grant = entry ? grantFromEntry(entry) : null;
    if (!grant) return;
    await this.mutateLedger((snapshot) => {
      const previous = snapshot.usage[grantId];
      return {
        version: 2,
        usage: { ...snapshot.usage, [grantId]: { lastUsedAt: now, useCount: (previous?.useCount ?? 0) + 1 } },
        audit: [...snapshot.audit, {
          id: randomUUID(),
          action: 'used',
          grantId,
          nodeId: grant.nodeId,
          capabilityId: grant.capabilityId,
          at: now,
          actor: grant.grantedBy,
        }],
      };
    });
  }

  /**
   * Revoke grants on the authority record, on every machine of the group. A
   * revocation is terminal: no later write, merge or restart brings the grant
   * back, and work still waiting for the phone under it is withdrawn.
   * Returns the itemised removals for disclosure: none when what was named is
   * already revoked, so a repeat after a lost reply still succeeds. A grant id
   * the record never held is refused with DeviceGrantNotFoundError.
   */
  async revoke(input: {
    readonly grantId?: string | undefined;
    readonly nodeId?: string | undefined;
    readonly capabilityId?: DeviceCapabilityId | undefined;
    readonly actor: string;
    readonly note?: string | undefined;
  }): Promise<readonly DeviceGrantRemoval[]> {
    if (!(input.grantId ?? input.nodeId ?? input.capabilityId)) return [];
    const now = this.now();
    let neverHeld = false;
    const written = await this.authority.write((view) => {
      neverHeld = input.grantId !== undefined && view.entry('device-grant', input.grantId) === null;
      if (neverHeld) return { kind: 'none', value: [] as DeviceGrantRemoval[] };
      const matches = this.liveOnRecord(view).live.filter(({ grant }) =>
        (input.grantId ? grant.id === input.grantId : true)
        && (input.nodeId ? grant.nodeId === input.nodeId : true)
        && (input.capabilityId ? grant.capabilityId === input.capabilityId : true));
      const removals = matches.map(({ grant }): DeviceGrantRemoval => ({
        grantId: grant.id,
        nodeId: grant.nodeId,
        capabilityId: grant.capabilityId,
        scope: grant.scope,
        reason: 'revoked',
        removedAt: now,
        ...(input.note ? { note: input.note } : {}),
      }));
      if (removals.length === 0) return { kind: 'none', value: removals };
      const reason = input.note ? `revoked: ${input.note}` : 'revoked';
      return {
        kind: 'many',
        value: removals,
        changes: matches.map(({ grant }): AuthorityChange<null> => ({ kind: 'revoke', key: grantKey(grant.id), by: input.actor, reason, value: null })),
      };
    });
    if (neverHeld) throw new DeviceGrantNotFoundError(input.grantId!);
    await this.recordRemovals(written.value, input.actor);
    return written.value;
  }

  private async recordRemovals(removals: readonly DeviceGrantRemoval[], actor: string, extra?: (snapshot: DeviceGrantSnapshot) => Pick<DeviceGrantSnapshot, 'audit'>): Promise<void> {
    if (removals.length === 0 && !extra) return;
    const removed = new Set(removals.map((removal) => removal.grantId));
    await this.mutateLedger((snapshot) => {
      const usage = Object.fromEntries(Object.entries(snapshot.usage).filter(([id]) => !removed.has(id)));
      const audit = [
        ...snapshot.audit,
        ...removals.filter((removal) => removal.grantId !== '(unreadable)').map((removal): DeviceGrantAuditRecord => ({
          id: randomUUID(),
          action: 'removed',
          grantId: removal.grantId,
          nodeId: removal.nodeId,
          capabilityId: removal.capabilityId,
          at: removal.removedAt,
          actor,
          reason: removal.reason,
        })),
      ];
      return { version: 2, usage, audit, ...(extra ? extra({ version: 2, usage, audit }) : {}) };
    });
  }

  /**
   * One housekeeping pass. Safe at recovery, safe on a timer, safe on every
   * machine at once: it judges the record as it reads it under the record's
   * writer lock, and revoking an already revoked grant changes nothing.
   */
  async sweep(): Promise<DeviceGrantSweepReport> {
    const now = this.now();
    // Read once for the whole pass, so the caps and cutoffs one sweep applies
    // are internally consistent even if the configuration changes mid-sweep.
    const policy = this.getPolicy();
    const written = await this.authority.write((view) => {
      const { live, malformed } = this.liveOnRecord(view);
      const removals: DeviceGrantRemoval[] = [];
      const revoke: { id: string; reason: DeviceGrantRemovalReason }[] = [];
      const remove = (grant: { id: string; nodeId: string; capabilityId: string; scope: string }, reason: DeviceGrantRemovalReason, note?: string): void => {
        removals.push({ grantId: grant.id, nodeId: grant.nodeId, capabilityId: grant.capabilityId, scope: grant.scope, reason, removedAt: now, ...(note ? { note } : {}) });
        revoke.push({ id: grant.id, reason });
      };
      for (const entry of malformed) {
        const fields = entry.public as Readonly<Record<string, unknown>>;
        remove({ id: entry.id, nodeId: String(fields['nodeId'] ?? '(unknown)'), capabilityId: String(fields['capabilityId'] ?? '(unknown)'), scope: String(fields['scope'] ?? '(unknown)') },
          'malformed', 'the grant failed content validation and was never honoured');
      }
      const surviving: DeviceCapabilityGrant[] = [];
      for (const { grant, entry } of live) {
        if (grant.expiresAt <= now) { remove(grant, 'expired'); continue; }
        if (this.ownership.isKnownNode && !this.ownership.isKnownNode(grant.nodeId)) { remove(grant, 'node-gone'); continue; }
        // Only the machine a session grant belongs to can tell its session is gone.
        if (grant.scope === 'session' && entry.audience !== 'group' && grant.sessionId && this.ownership.isActiveSession
          && !this.ownership.isActiveSession(grant.sessionId)) { remove(grant, 'session-gone'); continue; }
        surviving.push(grant);
      }
      // Oldest first, ties by id, so every machine picks the same grants past a cap.
      const byAge = (a: DeviceCapabilityGrant, b: DeviceCapabilityGrant): number => a.grantedAt - b.grantedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const byNode = new Map<string, DeviceCapabilityGrant[]>();
      for (const grant of surviving) byNode.set(grant.nodeId, [...(byNode.get(grant.nodeId) ?? []), grant]);
      const capped: DeviceCapabilityGrant[] = [];
      for (const bucket of byNode.values()) {
        bucket.sort(byAge);
        const overflow = bucket.length - policy.maxGrantsPerNode;
        bucket.forEach((grant, index) => { if (index < overflow) remove(grant, 'per-node-cap'); else capped.push(grant); });
      }
      capped.sort(byAge);
      const totalOverflow = capped.length - policy.maxGrantsTotal;
      const retained = capped.filter((grant, index) => {
        if (index >= totalOverflow) return true;
        remove(grant, 'total-cap');
        return false;
      }).length;
      const value = { removals, retained };
      if (revoke.length === 0) return { kind: 'none', value };
      return {
        kind: 'many',
        value,
        changes: revoke.map(({ id, reason }): AuthorityChange<null> => ({ kind: 'revoke', key: grantKey(id), by: 'housekeeping', reason, value: null })),
      };
    });
    let auditTrimmed = 0;
    const auditCutoff = now - policy.auditRetentionMs;
    await this.recordRemovals(written.value.removals, 'housekeeping', (snapshot) => {
      // Who was granted what and how it ended is a security record: every `granted` and `removed`
      // entry is kept. Only `used` entries age out (past the retention window, then past the newest
      // maxAuditRecords uses); each grant keeps its use count and last use in `usage`.
      const uses = snapshot.audit.filter((entry) => entry.action === 'used' && entry.at >= auditCutoff);
      const keptUses = new Set(uses.slice(-policy.maxAuditRecords));
      const kept = snapshot.audit.filter((entry) => entry.action !== 'used' || keptUses.has(entry));
      auditTrimmed = snapshot.audit.length - kept.length;
      return { audit: kept };
    });
    return {
      sweptAt: now,
      removed: written.value.removals,
      retained: written.value.retained,
      auditTrimmed: Math.max(0, auditTrimmed),
    };
  }
}

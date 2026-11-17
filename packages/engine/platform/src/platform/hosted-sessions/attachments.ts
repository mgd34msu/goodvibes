/**
 * attachments.ts, who is watching a hosted session, and for how long.
 *
 * An attachment is a claim about a LIVE process, and the only way it used to
 * end was a client calling `sessions.hosted.detach`. A client that crashed, was
 * killed, or simply had its tab closed makes no such call: its attachment stood
 * for as long as the daemon ran, and a `kill`-policy session, the default,
 * waited for a departure that was never going to arrive. The session that was
 * supposed to end when the last person left instead outlived everyone watching
 * it, holding a workspace floor and a model connection.
 *
 * So an attachment carries a LEASE, exactly as the conversation-rewind host
 * registration does (platform/rewind/conversation-host-broker.ts): a claim
 * bounded by time rather than by anyone remembering to clean up. Two things
 * renew it, and between them no client has to learn a new call:
 *
 *  1. Attaching again. `sessions.hosted.attach` is idempotent and always was,
 *    the same client id re-attaching now also renews, which is the same
 *    "polling renews the lease" shape the rewind host uses.
 *  2. The client's control-plane connection still being open. A client that
 *    attached under the same id it opened its event stream with is renewed by
 *    the daemon's own observation that it is still there, so an attached client
 *    watching a long turn in silence is never reaped for being quiet.
 *
 * The lease is `hostedSessions.attachmentTtlMs`, ten minutes by default, which
 * is far longer than any disconnect a client recovers from on its own and far
 * shorter than "until the daemon restarts".
 */

/** Floor and ceiling for a lease, whoever asks for it. */
export const HOSTED_ATTACHMENT_MIN_LEASE_MS = 30_000;
export const HOSTED_ATTACHMENT_MAX_LEASE_MS = 24 * 60 * 60_000;
export const HOSTED_ATTACHMENT_DEFAULT_LEASE_MS = 10 * 60_000;

/**
 * How often lapsed attachments are swept, for a given lease.
 *
 * A quarter of the lease, bounded to [15s, 60s], often enough that a
 * kill-policy session ends promptly after its last watcher vanishes, rarely
 * enough to be invisible on an idle daemon.
 */
export function attachmentSweepIntervalFor(leaseMs: number): number {
  return Math.min(60_000, Math.max(15_000, Math.floor(leaseMs / 4)));
}

/** A requested lease, clamped. A non-number or a non-positive one takes the default. */
export function clampAttachmentLease(requestedMs: number | undefined, fallbackMs: number): number {
  const requested = typeof requestedMs === 'number' && Number.isFinite(requestedMs) && requestedMs > 0
    ? Math.floor(requestedMs)
    : fallbackMs;
  return Math.min(Math.max(requested, HOSTED_ATTACHMENT_MIN_LEASE_MS), HOSTED_ATTACHMENT_MAX_LEASE_MS);
}

/**
 * One hosted session's attachments, each with the moment its lease runs out,
 * and the session's identified owners.
 *
 * An owner is a principal that created the session or attached to it. It
 * stays an owner when its client detaches, its lease runs out or the session
 * ends: leaving does not hand the session's contracts to whoever comes next.
 * The engine persists the owners with the session, so a restart keeps them.
 */
export class HostedSessionAttachments {
  private readonly leases = new Map<string, number>();
  /** The principal that first attached each client id, when the caller was identified. */
  private readonly owners = new Map<string, string>();
  /** Every principal that identified itself on the session; never shrinks. */
  private readonly principals: Set<string>;

  constructor(principals: Iterable<string> = []) {
    this.principals = new Set(principals);
  }

  /** Attach or renew. Returns when the lease now runs out. */
  renew(clientId: string, at: number, leaseMs: number, principalId?: string): number {
    const expiresAt = at + clampAttachmentLease(leaseMs, HOSTED_ATTACHMENT_DEFAULT_LEASE_MS);
    this.leases.set(clientId, expiresAt);
    if (principalId !== undefined && !this.owners.has(clientId)) this.owners.set(clientId, principalId);
    if (principalId !== undefined) this.principals.add(principalId);
    return expiresAt;
  }

  /** The session's identified owners, as persisted with it. */
  identifiedOwners(): string[] {
    return [...this.principals];
  }

  /**
   * Whether an attachment was made by a principal other than `principalId`.
   * An attachment made without an identified caller has no owner to protect.
   */
  ownedByAnother(clientId: string, principalId: string | undefined): boolean {
    const owner = this.owners.get(clientId);
    return owner !== undefined && owner !== principalId;
  }

  /**
   * Whether the session has identified owners and `principalId` is none of them.
   * A session nobody identified themselves on has no owner to protect.
   */
  ownedByOthers(principalId: string | undefined): boolean {
    if (this.principals.size === 0) return false;
    return principalId === undefined || !this.principals.has(principalId);
  }

  delete(clientId: string): boolean {
    this.owners.delete(clientId);
    return this.leases.delete(clientId);
  }

  clear(): void {
    this.leases.clear();
    this.owners.clear();
  }

  get size(): number {
    return this.leases.size;
  }

  clientIds(): string[] {
    return [...this.leases.keys()];
  }

  /** When this attachment's lease runs out, or null when there is no such attachment. */
  expiresAt(clientId: string): number | null {
    return this.leases.get(clientId) ?? null;
  }

  /**
   * Drop and return every attachment whose lease has run out.
   *
   * `isConnected` is the second renewal signal: a client the control plane can
   * still see is renewed in place rather than reaped, so a client that attached
   * under its stream's own id never has to heartbeat at all. A probe that
   * throws is treated as "cannot tell", which renews, refusing to answer must
   * not become a reason to end someone's session.
   */
  expire(at: number, leaseMs: number, isConnected?: (clientId: string) => boolean): string[] {
    const expired: string[] = [];
    for (const [clientId, expiresAt] of [...this.leases.entries()]) {
      if (expiresAt > at) continue;
      if (isConnected && stillConnected(isConnected, clientId)) {
        this.renew(clientId, at, leaseMs);
        continue;
      }
      this.leases.delete(clientId);
      this.owners.delete(clientId);
      expired.push(clientId);
    }
    return expired;
  }
}

function stillConnected(isConnected: (clientId: string) => boolean, clientId: string): boolean {
  try {
    return isConnected(clientId);
  } catch {
    return true;
  }
}

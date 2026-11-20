/**
 * review-tokens.ts, the one single-use, short-lived token a preview hands out
 * and the matching apply spends: `rewind.plan` / `rewind.apply`,
 * `checkpoints.restorePreview` / `checkpoints.restore`, the hunk revert pair.
 *
 * A token is bound to the {@link TargetRef} of what the preview showed. The
 * apply builds the reference of its target as it is now; the token is spent
 * whatever the outcome, and it authorises the apply only when it was issued
 * here, has not expired, and nothing in the target changed. A changed target
 * comes back with the change list, so the caller refuses with
 * `TARGET_CHANGED` naming what moved instead of a bare "token invalid".
 *
 * Held only in the daemon process that will perform the apply: a preview seen
 * is acknowledged here, not in a durable two-phase protocol.
 */
import { randomUUID } from 'node:crypto';
import type { TargetChange } from '@goodvibes/engine/errors';
import { compareTarget, type TargetRef } from '../utils/target-ref.js';

/** ~2 minutes: long enough to read a preview and confirm, short enough not to linger. */
export const REVIEW_TOKEN_TTL_MS = 120_000;

export interface IssuedReviewToken {
  readonly token: string;
  readonly expiresAt: number;
}

export type ReviewTokenConsumption =
  | { readonly ok: true; readonly reviewed: TargetRef }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'changed'; readonly reviewed?: TargetRef; readonly changes?: readonly TargetChange[] };

interface StoredReview {
  readonly reviewed: TargetRef;
  readonly expiresAt: number;
}

export class ReviewTokenStore {
  private readonly tokens = new Map<string, StoredReview>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = REVIEW_TOKEN_TTL_MS,
  ) {}

  /** Mint a fresh single-use token bound to what the preview showed. */
  issue(reviewed: TargetRef): IssuedReviewToken {
    this.pruneExpired();
    const token = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(token, { reviewed, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Spend `token` against the target as it is now (`null` when it is gone).
   * Single use: a found token is spent whatever the outcome.
   */
  consume(token: string, current: TargetRef | null): ReviewTokenConsumption {
    const stored = this.tokens.get(token);
    if (!stored) return { ok: false, reason: 'unknown' };
    this.tokens.delete(token);
    if (stored.expiresAt <= this.now()) return { ok: false, reason: 'expired', reviewed: stored.reviewed };
    const changes = compareTarget(stored.reviewed, current);
    if (changes.length > 0) return { ok: false, reason: 'changed', reviewed: stored.reviewed, changes };
    return { ok: true, reviewed: stored.reviewed };
  }

  /**
   * What a token was issued for, without spending it: an apply that resolves
   * its target from the token (the workspace root a hunk preview named)
   * instead of from the call. Undefined when unknown or expired.
   */
  peek(token: string): TargetRef | undefined {
    const stored = this.tokens.get(token);
    return stored && stored.expiresAt > this.now() ? stored.reviewed : undefined;
  }

  private pruneExpired(): void {
    const cutoff = this.now();
    for (const [token, stored] of this.tokens) {
      if (stored.expiresAt <= cutoff) this.tokens.delete(token);
    }
  }
}

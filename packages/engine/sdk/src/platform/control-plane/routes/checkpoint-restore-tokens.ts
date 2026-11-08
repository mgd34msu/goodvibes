/**
 * routes/checkpoint-restore-tokens.ts
 *
 * In-memory, single-use, short-lived confirmation tokens for the
 * `checkpoints.restore` server-side confirmation gate.
 *
 * Preview mints a token bound to the checkpoint id or exact private hunk values;
 * the matching restore/revert call consumes it exactly once.
 * A token expires ~2 minutes after issue and is destroyed the moment it is
 * consumed, so it can neither be replayed nor outlive the caller's decision.
 * This is deliberately NOT a durable, cross-process two-phase protocol, it is
 * a lightweight acknowledgment that a preview was seen, held only in the live
 * daemon process that will perform the restore.
 */
import { randomUUID } from 'node:crypto';

/** ~2 minutes: long enough for a human to read a preview and confirm, short enough to not linger. */
export const RESTORE_TOKEN_TTL_MS = 120_000;

type ConfirmationBinding = string | { readonly path: string; readonly hunk: string };
interface StoredToken {
  readonly binding: ConfirmationBinding;
  readonly expiresAt: number;
}

export interface IssuedRestoreToken {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * A tiny map-backed store of restore-confirmation tokens. Not exported through
 * the SDK public surface, constructed once per daemon at checkpoint-route
 * registration and shared between the preview and restore handlers.
 */
export class RestoreTokenStore {
  private readonly tokens = new Map<string, StoredToken>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = RESTORE_TOKEN_TTL_MS,
  ) {}

  /** Retain the exact private checkpoint or hunk selection, never a content ID. */
  issue(binding: ConfirmationBinding): IssuedRestoreToken {
    this.pruneExpired();
    const token = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    const selected = typeof binding === 'string' ? binding : Object.freeze({ path: binding.path, hunk: binding.hunk });
    this.tokens.set(token, { binding: selected, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Consume `token` for the exact checkpoint or hunk selection. Returns true only
   * when it exists, has not expired, and was minted for these exact values.
   * The token is removed on any consume attempt that finds it (success or
   * selection mismatch), so it can never be reused.
   */
  consume(token: string, binding: ConfirmationBinding): boolean {
    const stored = this.tokens.get(token);
    if (!stored) return false;
    // Single-use: found means spent, regardless of the outcome below.
    this.tokens.delete(token);
    if (stored.expiresAt <= this.now()) return false;
    return typeof stored.binding === 'string' ? stored.binding === binding
      : typeof binding !== 'string' && stored.binding.path === binding.path && stored.binding.hunk === binding.hunk;
  }

  /** Drop every token past its TTL. Called opportunistically on issue. */
  private pruneExpired(): void {
    const cutoff = this.now();
    for (const [token, stored] of this.tokens) {
      if (stored.expiresAt <= cutoff) this.tokens.delete(token);
    }
  }
}

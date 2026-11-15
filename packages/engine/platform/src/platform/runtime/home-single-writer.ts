/**
 * home-single-writer.ts, one live process per surface home, checked at boot.
 *
 * ── The failure this closes ────────────────────────────────────────────────
 *
 * A turn forked a SECOND full agent onto the home a live agent was already
 * running out of (`python -c 'pty.fork()'` then `execvp goodvibes-agent`). Two
 * processes then owned one `.goodvibes/agent/` tree: two writers over the same
 * session files, the same state store, the same transcript, which is how a
 * temp-file race killed a process, and how a ghost session was left marked
 * "active" by a writer that no longer existed.
 *
 * Nothing refused, because nothing was asking. A surface home had no notion of
 * an owner at all: whoever opened it, owned it, and the second opener was
 * indistinguishable from the first.
 *
 * ── What this is, and what it is not ───────────────────────────────────────
 *
 * This is the PROCESS-level guard: at boot, a surface claims its home, and a
 * second live process claiming the same home is REFUSED with a message naming
 * the pid that holds it. It is not a mutex around a write and it does not wait
 * for the holder to finish: waiting is the wrong answer to "another copy of me
 * is already running", and a boot that hangs is worse than a boot that says
 * why it stopped. It retries for a moment only, so a copy that is just exiting
 * (a restart) is not mistaken for one that is running.
 *
 * The STORE-level half, serializing two writers of one JSON file so neither
 * tears the other's write, is a different layer with a different answer (the
 * per-store process lock). Both are wanted; neither substitutes for the other.
 *
 * ── How ownership is decided ───────────────────────────────────────────────
 *
 * The claim is the kernel-released process lock on
 * `<home>/.goodvibes/<surface>/owner.writer.sqlite`, held for the life of the
 * process. The operating system releases it when the holder exits, however it
 * exits, on every platform: there is no liveness inference, no command-line
 * identity and no pid-reuse rule. `owner.json` beside it records the holder's
 * pid and claim time so a refusal can name them; it is information, not the
 * claim.
 */

import { readFileSync, rmSync } from 'node:fs';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { holdProcessLock, type HeldProcessLock } from '../utils/process-lock.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The record written beside the lock so a refusal can name the holder. */
export interface HomeOwnerClaim {
  readonly pid: number;
  /** Epoch millis the claim was taken. */
  readonly claimedAt: number;
}

/**
 * How a refusal reads. Names the pid, the home, and what to do, a message
 * that only says "already running" leaves the person with no next step.
 */
export function homeClaimRefusalMessage(input: {
  readonly holderPid: number;
  readonly surfaceRoot: string;
  readonly homePath: string;
  readonly claimedAt: number;
}): string {
  const owner = input.holderPid > 0
    ? `  owner pid: ${input.holderPid}${input.claimedAt > 0 ? ` (claimed ${new Date(input.claimedAt).toISOString()})` : ''}`
    : '  owner pid: not yet recorded (the other process is starting)';
  const stop = input.holderPid > 0 ? `stop it (pid ${input.holderPid})` : 'stop it';
  return [
    `Refusing to start: this ${input.surfaceRoot} home is already owned by a live process.`,
    `  home: ${input.homePath}`,
    owner,
    'Two processes writing one home is what corrupts sessions and leaves ghost "active"',
    'entries behind, so this one is stopping instead.',
    `Use the process that is already running, or ${stop} and start again.`,
  ].join('\n');
}

/** Where a surface's owner record lives. */
export function surfaceHomeClaimPath(homeDirectory: string, surfaceRoot: string): string {
  return join(homeDirectory, '.goodvibes', surfaceRoot, 'owner.json');
}

/** The lock file whose kernel lock is the claim. */
export function surfaceHomeLockPath(homeDirectory: string, surfaceRoot: string): string {
  return join(homeDirectory, '.goodvibes', surfaceRoot, 'owner.writer.sqlite');
}

/** Read the owner record, or null when there is none / it is unreadable. */
function readClaim(path: string): HomeOwnerClaim | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HomeOwnerClaim>;
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, claimedAt: Number.isFinite(Number(parsed.claimedAt)) ? Number(parsed.claimedAt) : 0 };
  } catch {
    return null;
  }
}

/** Raised when another live process already owns this home. `holderPid` is 0 when the holder has not recorded itself yet. */
export class SurfaceHomeInUseError extends Error {
  readonly holderPid: number;
  constructor(message: string, holderPid: number) {
    super(message);
    this.name = 'SurfaceHomeInUseError';
    this.holderPid = holderPid;
  }
}

/** What a successful claim hands back. */
export interface SurfaceHomeClaim {
  /** The owner record this process wrote. */
  readonly path: string;
  /** Drop the claim. Idempotent; the home is free once the last holder in this process releases. */
  release(): void;
}

/**
 * The claims this process holds, by lock path, with how many holders stand on
 * each. One process may legitimately compose several graphs over one home (the
 * daemon builds a workspace floor per hosted workspace, all under its own
 * home); the first of them to be disposed must not give up a claim the others
 * still stand on.
 */
const heldClaims = new Map<string, { lock: HeldProcessLock; count: number }>();

/** How long a claim retries a held lock before refusing: a copy that is exiting releases within this. */
const CLAIM_RETRY_MS = 500;
const CLAIM_RETRY_STEP_MS = 25;

export interface ClaimSurfaceHomeOptions {
  readonly homeDirectory: string;
  readonly surfaceRoot: string;
  /** Clock for the recorded claim time; the real one is the default. */
  readonly now?: (() => number) | undefined;
}

function takeLock(lockPath: string): HeldProcessLock | null {
  const deadline = Date.now() + CLAIM_RETRY_MS;
  let pause: Int32Array | null = null;
  for (;;) {
    const lock = holdProcessLock(lockPath);
    if (lock || Date.now() >= deadline) return lock;
    // Boot only, and only while another process holds the home.
    pause ??= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(pause, 0, 0, CLAIM_RETRY_STEP_MS);
  }
}

/**
 * Claim this surface's home for this process, or refuse.
 *
 * @throws SurfaceHomeInUseError when another live process holds it. The message
 *   names the holding pid and is written to be shown to a person as-is.
 */
export function claimSurfaceHome(options: ClaimSurfaceHomeOptions): SurfaceHomeClaim {
  const path = surfaceHomeClaimPath(options.homeDirectory, options.surfaceRoot);
  const lockPath = surfaceHomeLockPath(options.homeDirectory, options.surfaceRoot);
  let held = heldClaims.get(lockPath);
  if (!held) {
    const lock = takeLock(lockPath);
    if (!lock) {
      const holder = readClaim(path);
      const holderPid = holder?.pid ?? 0;
      throw new SurfaceHomeInUseError(homeClaimRefusalMessage({
        holderPid,
        surfaceRoot: options.surfaceRoot,
        homePath: path,
        claimedAt: holder?.claimedAt ?? 0,
      }), holderPid);
    }
    try {
      writeJsonFileAtomic(path, { pid: process.pid, claimedAt: (options.now ?? Date.now)() });
    } catch (error) {
      lock.release();
      throw error;
    }
    held = { lock, count: 0 };
    heldClaims.set(lockPath, held);
  }
  held.count += 1;
  const owned = held;
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      if (heldClaims.get(lockPath) !== owned) return;
      if (--owned.count > 0) return;
      heldClaims.delete(lockPath);
      // The record is removed while the lock is still held, so it can only be ours.
      try {
        rmSync(path, { force: true });
      } catch (error) {
        logger.debug('home-single-writer: removing the owner record failed', { path, error: summarizeError(error) });
      }
      owned.lock.release();
    },
  };
}

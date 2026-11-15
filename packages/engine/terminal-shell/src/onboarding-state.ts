import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '@goodvibes-jev/engine/platform/platform/config';
import { readVersioned, setAsideNewerVersionFile } from '@goodvibes-jev/engine/platform/platform/config';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { OnboardingAcknowledgementRuntimeState, OnboardingAcknowledgementTarget, OnboardingMode, OnboardingShellPaths, OnboardingStateScope, } from './onboarding-state-types.js';
const ONBOARDING_RUNTIME_STATE_FILE = 'onboarding-state.json';
/**
 * Lockfile serialisation for writeOnboardingAcknowledgementState.
 *
 * Mechanism: O_EXCL advisory lockfile in the same directory as the state file.
 * This is the simplest correct approach for two same-host processes (daemon
 * + TUI) that both run this read-modify-write path:
 *
 *   - Acquire: open(<statefile>.lock, O_CREAT|O_EXCL|O_WRONLY), atomic on POSIX.
 *   - Stale detection: if the lockfile mtime is >= LOCK_STALE_MS old, force-remove.
 *   - Retry: up to LOCK_MAX_RETRIES attempts LOCK_RETRY_MS apart, which spans the stale window so a crashed holder is taken over.
 *   - Release: unlink the lockfile only while it still carries this writer's token (best-effort on failure).
 *
 * O_EXCL was chosen over flock(2) because it works on all POSIX targets
 * without requiring an open fd on the guarded file, and is Bun-compatible.
 */
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 20;
const LOCK_MAX_RETRIES = Math.ceil(LOCK_STALE_MS / LOCK_RETRY_MS) + 25;
/** The write path is synchronous, so waiting for the holder blocks the thread for a few milliseconds at a time. */
function blockingSleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** Clock and sleep seams for the lock wait. */
export interface OnboardingStateLockTiming {
    readonly sleep?: ((ms: number) => void) | undefined;
    readonly now?: (() => number) | undefined;
}
export interface OnboardingRuntimeStateRecord {
    readonly scope: OnboardingStateScope;
    readonly path: string;
    readonly exists: boolean;
    readonly payload: OnboardingAcknowledgementRuntimeState | null;
    readonly parseError?: string | undefined;
}
interface WriteOnboardingAcknowledgementStateOptions {
    readonly scope?: OnboardingStateScope | undefined;
    readonly target: OnboardingAcknowledgementTarget;
    readonly acknowledged: boolean;
    readonly updatedAt?: number | undefined;
    readonly source: string;
    readonly mode?: OnboardingMode | undefined;
    readonly workspaceRoot?: string | undefined;
}
export function createOnboardingStateStorage(surfaceRoot: string, timing: OnboardingStateLockTiming = {}) {
    const sleep = timing.sleep ?? blockingSleep;
    const now = timing.now ?? Date.now;
    function resolveStatePath(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope): string {
        return scope === 'project'
            ? shellPaths.resolveProjectPath(surfaceRoot, ONBOARDING_RUNTIME_STATE_FILE)
            : shellPaths.resolveUserPath(surfaceRoot, ONBOARDING_RUNTIME_STATE_FILE);
    }
    function isAcknowledgementTarget(value: string): value is OnboardingAcknowledgementTarget {
        return value === 'providers' || value === 'subscriptions' || value === 'auth';
    }
    function isRuntimeStatePayload(value: unknown): value is OnboardingAcknowledgementRuntimeState {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return false;
        const v = value as Record<string, unknown>;
        if (v['version'] !== 1)
            return false;
        if (typeof v['updatedAt'] !== 'number' || !Number.isFinite(v['updatedAt'] as number))
            return false;
        if (typeof v['source'] !== 'string')
            return false;
        const mode = v['mode'];
        if (mode !== undefined && mode !== 'new' && mode !== 'edit' && mode !== 'reopen')
            return false;
        if (v['workspaceRoot'] !== undefined && typeof v['workspaceRoot'] !== 'string')
            return false;
        if (typeof v['acknowledgements'] !== 'object' || v['acknowledgements'] === null)
            return false;
        return Object.entries(v['acknowledgements'] as Record<string, unknown>).every(([key, entry]) => isAcknowledgementTarget(key) && typeof entry === 'boolean');
    }
    // ─── Lock helpers ──────────────────────────────────────────────────────────────────
    function stateLockPath(statePath: string): string {
        return `${statePath}.lock`;
    }
    /**
     * Acquire an O_EXCL advisory lock, waiting for a live holder. Returns the
     * token written into the lockfile, or null when the wait ran out.
     * Stale locks (older than LOCK_STALE_MS) are forcibly removed before retry.
     */
    function acquireLock(lp: string): string | null {
        const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
        for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
            // Stale-lock takeover: if the lockfile is old enough, forcibly remove it.
            try {
                const st = statSync(lp);
                if (now() - st.mtimeMs >= LOCK_STALE_MS) {
                    try {
                        unlinkSync(lp);
                    }
                    catch { /* another process may have beaten us */ }
                }
            }
            catch { /* lockfile does not exist, expected happy path */ }
            try {
                // 'wx' ≡ O_CREAT | O_EXCL | O_WRONLY, fails atomically if file exists.
                const fd = openSync(lp, 'wx');
                try {
                    writeSync(fd, token);
                }
                finally {
                    closeSync(fd);
                }
                return token;
            }
            catch { /* file exists, held by another process */ }
            sleep(LOCK_RETRY_MS);
        }
        return null;
    }
    /** Release the advisory lockfile (best-effort); a lock another writer took over after going stale stays theirs. */
    function releaseLock(lp: string, token: string): void {
        try {
            if (readFileSync(lp, 'utf-8') !== token)
                return;
            unlinkSync(lp);
        }
        catch { /* best-effort */ }
    }
    // ─── Public API ────────────────────────────────────────────────────────────────────
    function getOnboardingRuntimeStatePath(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope = 'project'): string {
        return resolveStatePath(shellPaths, scope);
    }
    function readOnboardingRuntimeState(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope = 'project'): OnboardingRuntimeStateRecord {
        const path = resolveStatePath(shellPaths, scope);
        const parsed = readVersioned<OnboardingAcknowledgementRuntimeState & {
            version: number;
        }>(path, { currentVersion: 1, onUnknown: 'quarantine' });
        if (parsed === null) {
            // readVersioned returns null for: missing file, corrupt JSON, or
            // unrecognised version (in which case it renames to <path>.unrecognized).
            const nowExists = existsSync(path);
            const quarantined = existsSync(`${path}.unrecognized`);
            return {
                scope,
                path,
                exists: nowExists || quarantined,
                payload: null,
                ...(quarantined
                    ? { parseError: 'Unrecognised or corrupt onboarding state file; quarantined.' }
                    : {}),
            };
        }
        if (!isRuntimeStatePayload(parsed)) {
            return {
                scope,
                path,
                exists: true,
                payload: null,
                parseError: 'Invalid onboarding runtime state payload.',
            };
        }
        return { scope, path, exists: true, payload: parsed };
    }
    function writeOnboardingAcknowledgementState(shellPaths: OnboardingShellPaths, options: WriteOnboardingAcknowledgementStateOptions): OnboardingRuntimeStateRecord {
        const scope = options.scope ?? 'project';
        const path = resolveStatePath(shellPaths, scope);
        const lp = stateLockPath(path);
        // Ensure the parent directory exists before we try to create the lockfile.
        mkdirSync(dirname(path), { recursive: true });
        const token = acquireLock(lp);
        if (token === null) {
            // The holder stayed alive past the stale window. The atomic write still prevents
            // torn files, but a concurrent read-modify-write can lose an update, so it is logged
            // (not printed: this runs under a live full-screen terminal).
            logger.warn('onboarding-state: lock wait ran out, proceeding without the lock', { path, target: options.target, source: options.source });
        }
        try {
            // Re-read (inside the lock when acquired; best-effort when degraded) to get
            // the freshest acknowledgements state, eliminating the read-modify-write
            // race between daemon and TUI under normal conditions.
            const existing = readOnboardingRuntimeState(shellPaths, scope);
            const updatedAt = options.updatedAt ?? Date.now();
            const ws = options.workspaceRoot ?? shellPaths.workingDirectory;
            const payload: OnboardingAcknowledgementRuntimeState = {
                version: 1,
                updatedAt,
                source: options.source,
                ...(options.mode ? { mode: options.mode } : {}),
                ...(ws ? { workspaceRoot: ws } : {}),
                acknowledgements: {
                    ...(existing.payload?.acknowledgements ?? {}),
                    [options.target]: options.acknowledged,
                },
            };
            // A file from a newer release is moved aside, not overwritten, so downgrading never destroys its state.
            setAsideNewerVersionFile(path, 1);
            atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mkdirp: true });
        }
        finally {
            if (token !== null)
                releaseLock(lp, token);
        }
        return readOnboardingRuntimeState(shellPaths, scope);
    }
    return { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState };
}

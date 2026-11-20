import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '@goodvibes/engine/platform/platform/config';
import { readVersioned, setAsideNewerVersionFile } from '@goodvibes/engine/platform/platform/config';
import { logger, ProcessLockBusyError, withProcessLockSync } from '@goodvibes/engine/platform/platform/utils';
import type { OnboardingAcknowledgementRuntimeState, OnboardingAcknowledgementTarget, OnboardingMode, OnboardingShellPaths, OnboardingStateScope, } from './onboarding-state-types.js';
const ONBOARDING_RUNTIME_STATE_FILE = 'onboarding-state.json';
/**
 * The acknowledgement write is a read-modify-write that the daemon and a
 * terminal can both run. It holds the kernel-released process lock beside the
 * state file: a crashed holder frees it with its process, so there is no stale
 * rule, token or retry loop. The locked section is one small read and one
 * atomic write, so the wait bound is short.
 */
const LOCK_WAIT_MS = 2000;
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
export function createOnboardingStateStorage(surfaceRoot: string) {
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
        // Ensure the parent directory exists before the lock file is created beside the state file.
        mkdirSync(dirname(path), { recursive: true });
        const write = (): void => {
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
        };
        try {
            withProcessLockSync(`${path}.writer.sqlite`, write, { waitMs: LOCK_WAIT_MS });
        }
        catch (error) {
            if (!(error instanceof ProcessLockBusyError))
                throw error;
            // The other writer holds the lock past the bound. The atomic write still
            // prevents a torn file; a concurrent update can be lost, so it is logged
            // (not printed: this runs under a live full-screen terminal).
            logger.warn('onboarding-state: the state file stayed locked, writing without the lock', { path, target: options.target, source: options.source });
            write();
        }
        return readOnboardingRuntimeState(shellPaths, scope);
    }
    return { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState };
}

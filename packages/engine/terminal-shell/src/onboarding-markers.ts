import { existsSync } from 'node:fs';
import { atomicWriteFileSync, readVersioned } from '@goodvibes-jev/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { OnboardingCheckMarkerPayload, OnboardingCheckMarkerState, OnboardingCheckMarkersState, OnboardingStateScope, WriteOnboardingCheckMarkerOptions, } from './onboarding-state-types.js';
const ONBOARDING_CHECK_MARKER_FILE = 'onboarding-checked.json';
const ONBOARDING_COMPLETION_MARKER_FILE = 'onboarding-complete.json';
type OnboardingShellPaths = Pick<ShellPathService, 'workingDirectory' | 'resolveProjectPath' | 'resolveUserPath'>;
export function createOnboardingMarkerStorage(surfaceRoot: string) {
    function resolveMarkerPath(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope, fileName = ONBOARDING_CHECK_MARKER_FILE): string {
        return scope === 'project'
            ? shellPaths.resolveProjectPath(surfaceRoot, fileName)
            : shellPaths.resolveUserPath(surfaceRoot, fileName);
    }
    function isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null;
    }
    function isOnboardingMode(value: unknown): value is OnboardingCheckMarkerPayload['mode'] {
        return value === 'new' || value === 'edit' || value === 'reopen';
    }
    function isCheckMarkerPayload(value: unknown): value is OnboardingCheckMarkerPayload {
        return isObject(value)
            && value.version === 1
            && typeof value.checkedAt === 'number'
            && Number.isFinite(value.checkedAt)
            && typeof value.updatedAt === 'number'
            && Number.isFinite(value.updatedAt)
            && typeof value.source === 'string'
            && (value.mode === undefined || isOnboardingMode(value.mode))
            && (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string');
    }
    function buildMissingMarkerState(scope: OnboardingStateScope, path: string): OnboardingCheckMarkerState {
        return {
            scope,
            path,
            exists: false,
            payload: null,
        };
    }
    function buildParseErrorState(scope: OnboardingStateScope, path: string, parseError: string): OnboardingCheckMarkerState {
        return {
            scope,
            path,
            exists: true,
            payload: null,
            parseError,
        };
    }
    function pickEffectiveMarker(user: OnboardingCheckMarkerState): OnboardingCheckMarkerState | null {
        if (user.payload)
            return user;
        if (user.exists)
            return user;
        return null;
    }
    function getOnboardingCheckMarkerPath(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope = 'user'): string {
        return resolveMarkerPath(shellPaths, scope);
    }
    function readOnboardingMarker(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope, fileName: string): OnboardingCheckMarkerState {
        const path = resolveMarkerPath(shellPaths, scope, fileName);
        const parsed = readVersioned<OnboardingCheckMarkerPayload & {
            version: number;
        }>(path, { currentVersion: 1, onUnknown: 'quarantine' });
        if (parsed === null) {
            const nowExists = existsSync(path), quarantined = existsSync(path + '.unrecognized');
            if (!nowExists && !quarantined)
                return buildMissingMarkerState(scope, path);
            return buildParseErrorState(scope, path, quarantined ? 'Unrecognised or corrupt marker file; quarantined.' : 'Invalid onboarding check marker payload.');
        }
        if (!isCheckMarkerPayload(parsed))
            return buildParseErrorState(scope, path, 'Invalid onboarding check marker payload.');
        return { scope, path, exists: true, payload: parsed };
    }
    function readOnboardingCheckMarker(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope = 'user'): OnboardingCheckMarkerState {
        return readOnboardingMarker(shellPaths, scope, ONBOARDING_CHECK_MARKER_FILE);
    }
    function getOnboardingCompletionMarkerPath(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope = 'user'): string {
        return resolveMarkerPath(shellPaths, scope, ONBOARDING_COMPLETION_MARKER_FILE);
    }
    function readOnboardingCompletionMarker(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope = 'user'): OnboardingCheckMarkerState {
        return readOnboardingMarker(shellPaths, scope, ONBOARDING_COMPLETION_MARKER_FILE);
    }
    function readOnboardingCheckMarkers(shellPaths: OnboardingShellPaths): OnboardingCheckMarkersState {
        const user = readOnboardingCheckMarker(shellPaths, 'user');
        const project = readOnboardingCheckMarker(shellPaths, 'project');
        return {
            user,
            project,
            effective: pickEffectiveMarker(user),
        };
    }
    function writeOnboardingMarker(shellPaths: OnboardingShellPaths, options: WriteOnboardingCheckMarkerOptions, fileName: string): OnboardingCheckMarkerState {
        const scope = options.scope ?? 'user';
        const path = resolveMarkerPath(shellPaths, scope, fileName);
        const checkedAt = options.checkedAt ?? Date.now();
        const payload: OnboardingCheckMarkerPayload = {
            version: 1,
            checkedAt,
            updatedAt: options.updatedAt ?? checkedAt,
            source: options.source ?? 'wizard',
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        };
        atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mkdirp: true });
        return readOnboardingMarker(shellPaths, scope, fileName);
    }
    function writeOnboardingCheckMarker(shellPaths: OnboardingShellPaths, options: WriteOnboardingCheckMarkerOptions = {}): OnboardingCheckMarkerState {
        return writeOnboardingMarker(shellPaths, options, ONBOARDING_CHECK_MARKER_FILE);
    }
    function writeOnboardingCompletionMarker(shellPaths: OnboardingShellPaths, options: WriteOnboardingCheckMarkerOptions = {}): OnboardingCheckMarkerState {
        return writeOnboardingMarker(shellPaths, options, ONBOARDING_COMPLETION_MARKER_FILE);
    }
    return { getOnboardingCheckMarkerPath, readOnboardingCheckMarker, readOnboardingCheckMarkers, writeOnboardingCheckMarker, getOnboardingCompletionMarkerPath, readOnboardingCompletionMarker, writeOnboardingCompletionMarker };
}

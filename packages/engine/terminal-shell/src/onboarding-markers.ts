import { existsSync } from 'node:fs';
import { atomicWriteFileSync, readVersioned, setAsideNewerVersionFile } from '@goodvibes/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { OnboardingCheckMarkerPayload, OnboardingCheckMarkerState, OnboardingStateScope, WriteOnboardingCheckMarkerOptions, } from './onboarding-state-types.js';
const ONBOARDING_CHECK_MARKER_FILE = 'onboarding-checked.json';
const ONBOARDING_COMPLETION_MARKER_FILE = 'onboarding-complete.json';
/** First run's "Who decides" step was answered or put off (`source`: 'answered' | 'put-off'): it is not opened again by itself. */
const WHO_DECIDES_MARKER_FILE = 'who-decides-asked.json';
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
    function getOnboardingCheckMarkerPath(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope = 'user'): string {
        return resolveMarkerPath(shellPaths, scope);
    }
    function readOnboardingMarker(shellPaths: OnboardingShellPaths, scope: OnboardingStateScope, fileName: string): OnboardingCheckMarkerState {
        const path = resolveMarkerPath(shellPaths, scope, fileName);
        const existedBefore = existsSync(path);
        let parsed: (OnboardingCheckMarkerPayload & { version: number }) | null;
        try {
            parsed = readVersioned<OnboardingCheckMarkerPayload & {
                version: number;
            }>(path, { currentVersion: 1, onUnknown: 'quarantine' });
        }
        catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.message : String(error));
            return buildParseErrorState(scope, path, `Onboarding marker could not be read: ${code}`);
        }
        if (parsed === null) {
            // Missing before this read: missing, whatever older quarantine copies sit beside it.
            if (!existedBefore)
                return buildMissingMarkerState(scope, path);
            return buildParseErrorState(scope, path, existsSync(path) ? 'Invalid onboarding check marker payload.' : 'Unrecognised or corrupt marker file; quarantined.');
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
        // A file from a newer release is moved aside, not overwritten, so downgrading never destroys its state.
        setAsideNewerVersionFile(path, 1);
        atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mkdirp: true });
        return readOnboardingMarker(shellPaths, scope, fileName);
    }
    function writeOnboardingCheckMarker(shellPaths: OnboardingShellPaths, options: WriteOnboardingCheckMarkerOptions = {}): OnboardingCheckMarkerState {
        return writeOnboardingMarker(shellPaths, options, ONBOARDING_CHECK_MARKER_FILE);
    }
    function writeOnboardingCompletionMarker(shellPaths: OnboardingShellPaths, options: WriteOnboardingCheckMarkerOptions = {}): OnboardingCheckMarkerState {
        return writeOnboardingMarker(shellPaths, options, ONBOARDING_COMPLETION_MARKER_FILE);
    }
    /** Whether first run's "Who decides" step was answered or put off on this surface (a readable record). */
    function readWhoDecidesAsked(shellPaths: OnboardingShellPaths): boolean {
        return readOnboardingMarker(shellPaths, 'user', WHO_DECIDES_MARKER_FILE).payload !== null;
    }
    /** Record that first run's "Who decides" step was answered or put off, so it is not opened again by itself. */
    function writeWhoDecidesAsked(shellPaths: OnboardingShellPaths, how: 'answered' | 'put-off'): void {
        writeOnboardingMarker(shellPaths, { source: how }, WHO_DECIDES_MARKER_FILE);
    }
    return { getOnboardingCheckMarkerPath, readOnboardingCheckMarker, writeOnboardingCheckMarker, getOnboardingCompletionMarkerPath, readOnboardingCompletionMarker, writeOnboardingCompletionMarker, readWhoDecidesAsked, writeWhoDecidesAsked };
}

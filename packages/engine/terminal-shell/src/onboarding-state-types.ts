import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
export type OnboardingShellPaths = Pick<ShellPathService, 'workingDirectory' | 'resolveProjectPath' | 'resolveUserPath'>;
export type OnboardingMode = 'new' | 'edit' | 'reopen';
export type OnboardingAcknowledgementTarget = 'providers' | 'subscriptions' | 'auth';
export type OnboardingStateScope = 'user' | 'project';
export type OnboardingCheckMarkerSource = 'wizard' | 'command' | 'import' | 'unknown';
export interface OnboardingAcknowledgementRuntimeState {
    readonly version: 1;
    readonly updatedAt: number;
    readonly source: string;
    readonly mode?: OnboardingMode | undefined;
    readonly workspaceRoot?: string | undefined;
    readonly acknowledgements: Partial<Record<OnboardingAcknowledgementTarget, boolean>>;
}
export interface OnboardingCheckMarkerPayload {
    readonly version: 1;
    readonly checkedAt: number;
    readonly updatedAt: number;
    readonly source: OnboardingCheckMarkerSource;
    readonly mode?: OnboardingMode | undefined;
    readonly workspaceRoot?: string | undefined;
}
export interface OnboardingCheckMarkerState {
    readonly scope: OnboardingStateScope;
    readonly path: string;
    readonly exists: boolean;
    readonly payload: OnboardingCheckMarkerPayload | null;
    readonly parseError?: string | undefined;
}
export interface OnboardingCheckMarkersState {
    readonly user: OnboardingCheckMarkerState;
    readonly project: OnboardingCheckMarkerState;
    readonly effective: OnboardingCheckMarkerState | null;
}
export interface WriteOnboardingCheckMarkerOptions {
    readonly scope?: OnboardingStateScope | undefined;
    readonly checkedAt?: number | undefined;
    readonly updatedAt?: number | undefined;
    readonly source?: OnboardingCheckMarkerSource | undefined;
    readonly mode?: OnboardingMode | undefined;
    readonly workspaceRoot?: string | undefined;
}
export interface OnboardingAcknowledgementSnapshot {
    readonly scope: OnboardingStateScope;
    readonly exists: boolean;
    readonly updatedAt: number | null;
    readonly source: string | null;
    readonly mode?: OnboardingMode | undefined;
    readonly workspaceRoot?: string | undefined;
    readonly accepted: Partial<Record<OnboardingAcknowledgementTarget, boolean>>;
}

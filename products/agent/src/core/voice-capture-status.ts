import type { VoiceCaptureIndicatorKind as Kind, VoiceCaptureIndicatorState as State } from '@goodvibes-jev/engine/terminal-shell/voice-capture-status';
export { voiceCaptureRowVisible } from '@goodvibes-jev/engine/terminal-shell/voice-capture-status';
export type VoiceCaptureIndicatorKind = Extract<Kind, `wake-${string}`>;
export type VoiceCaptureIndicatorState = State<VoiceCaptureIndicatorKind>;

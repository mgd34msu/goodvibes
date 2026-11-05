import type { VoiceCaptureIndicatorKind as Kind, VoiceCaptureIndicatorState as State } from '@goodvibes-jev/engine/terminal-shell/voice-capture-status';
export { voiceCaptureRowVisible } from '@goodvibes-jev/engine/terminal-shell/voice-capture-status';
export type VoiceCaptureIndicatorKind = Exclude<Kind, 'wake-starting' | 'wake-no-audio' | 'wake-no-microphone'>;
export type VoiceCaptureIndicatorState = State<VoiceCaptureIndicatorKind>;

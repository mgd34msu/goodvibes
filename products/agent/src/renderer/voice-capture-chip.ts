import { voiceCaptureDescription as describe } from '@goodvibes-jev/engine/terminal-shell/voice-capture-chip';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
export * from '@goodvibes-jev/engine/terminal-shell/voice-capture-chip';
export const voiceCaptureDescription = (state: VoiceCaptureIndicatorState) => describe(state, ',');

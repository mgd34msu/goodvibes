import { playActivationSound as play, type ActivationSoundPlayerDeps } from '@goodvibes-jev/engine/terminal-shell/activation-sound';
import type { WakeActivationSound } from '@goodvibes-jev/engine/sdk/platform/voice';
export * from '@goodvibes-jev/engine/terminal-shell/activation-sound';
export const playActivationSound = (sound: WakeActivationSound, deps: ActivationSoundPlayerDeps) => play(sound, deps, '[Wake]');

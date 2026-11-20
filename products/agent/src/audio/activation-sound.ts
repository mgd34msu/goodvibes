import { playActivationSound as play, type ActivationSoundPlayerDeps } from '@goodvibes/engine/terminal-shell/activation-sound';
import type { WakeActivationSound } from '@goodvibes/engine/platform/platform/voice';
export * from '@goodvibes/engine/terminal-shell/activation-sound';
export const playActivationSound = (sound: WakeActivationSound, deps: ActivationSoundPlayerDeps) => play(sound, deps, '[Wake]');

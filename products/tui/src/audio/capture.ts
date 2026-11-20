import { createTerminalCaptureOpener, type TerminalCaptureOpenerOptions } from '@goodvibes/engine/terminal-shell/audio-capture';
export { spawnRecorderProcess, isExecutableOnPath } from '@goodvibes/engine/terminal-shell/audio-capture';
export type TuiCaptureOpenerOptions = Omit<TerminalCaptureOpenerOptions, 'speexAvailable'>;
/** The raw recorder does not claim to apply a filter; the owning voice pipeline does. */
export const createTuiCaptureOpener = (options: TuiCaptureOpenerOptions = {}) => createTerminalCaptureOpener({ ...options, speexAvailable: false });

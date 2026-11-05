import { extractNativeHeadlessOptions as extract } from '@goodvibes-jev/engine/terminal-shell/native';
export type { NativeHeadlessMode } from '@goodvibes-jev/engine/terminal-shell/native';
export const extractNativeHeadlessOptions = (argv: readonly string[]) => extract(argv, { required: ['--daemon-home'], optional: ['--fork'] });

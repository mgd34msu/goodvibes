import { executeNativeHeadless as execute, writeNativeHeadlessResult as write, type NativeHeadlessOptions, type NativeHeadlessResult } from '@goodvibes-jev/engine/terminal-shell/native-headless';
export * from '@goodvibes-jev/engine/terminal-shell/native-headless';
export const executeNativeHeadless = (options: NativeHeadlessOptions) => execute(options, { allowHosted: false, allowSelectedDiff: true }, 'credential');
export const writeNativeHeadlessResult = (result: NativeHeadlessResult, format: string, stdout: (line: string) => void) => write(result, format, stdout, false);

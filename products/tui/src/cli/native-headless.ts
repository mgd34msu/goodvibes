import { executeNativeHeadless as execute, writeNativeHeadlessResult as write, type NativeHeadlessOptions, type NativeHeadlessResult } from '@goodvibes-jev/engine/terminal-shell/native-headless';
import { TUI_NATIVE_INTAKE_POLICY } from '@goodvibes-jev/engine/terminal-shell/native-intake';
export * from '@goodvibes-jev/engine/terminal-shell/native-headless';
export const executeNativeHeadless = (options: NativeHeadlessOptions) => execute(options, TUI_NATIVE_INTAKE_POLICY, 'credential');
export const writeNativeHeadlessResult = (result: NativeHeadlessResult, format: string, stdout: (line: string) => void, stderr?: (line: string) => void) => write(result, format, stdout, false, stderr);

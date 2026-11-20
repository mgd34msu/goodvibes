import { executeNativeHeadless as execute, writeNativeHeadlessResult as write, type NativeHeadlessOptions, type NativeHeadlessResult } from '@goodvibes/engine/terminal-shell/native-headless';
import { AGENT_NATIVE_INTAKE_POLICY } from '@goodvibes/engine/terminal-shell/native-intake';
export * from '@goodvibes/engine/terminal-shell/native-headless';
export const executeNativeHeadless = (options: NativeHeadlessOptions) => execute(options, AGENT_NATIVE_INTAKE_POLICY, 'paired');
export const writeNativeHeadlessResult = (result: NativeHeadlessResult, format: string, stdout: (line: string) => void, stderr?: (line: string) => void) => write(result, format, stdout, true, stderr);

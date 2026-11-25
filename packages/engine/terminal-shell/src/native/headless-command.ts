import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { NativeHeadlessMode } from './native-headless-options.js';
import type { NativeHeadlessResult } from './native-headless.js';
export interface HeadlessCommandRuntime {
  readonly cli: {
    readonly flags: { readonly prompt?: string | undefined; readonly outputFormat: string;
      readonly continueLast?: boolean | undefined; readonly resume?: string | undefined; readonly session?: string | undefined;
      readonly promptFile?: string | undefined };
    readonly commandArgs: readonly string[];
    readonly positionals: readonly string[];
  };
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
}
/** Own cancellation through runtime cleanup and the last byte of command output. */
export async function runHeadlessCommand(
  runtime: HeadlessCommandRuntime,
  mode: NativeHeadlessMode,
  policy: {
    readonly run: (prompt: string | undefined, mode: NativeHeadlessMode, signal: AbortSignal) => Promise<NativeHeadlessResult>;
    readonly write: (result: NativeHeadlessResult, format: string, output: (line: string) => void) => void;
  },
): Promise<number> {
  const { cli } = runtime;
  const typed = cli.flags.prompt ?? (cli.positionals.length ? cli.positionals.join(' ') : undefined);
  const read = cli.flags.promptFile === undefined ? { prompt: typed } : readPromptFile(cli.flags.promptFile, typed, runtime.workingDirectory);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const result = 'error' in read
      ? { exitCode: 2, response: '', error: read.error, stopReason: 'invalid-input' }
      : await policy.run(read.prompt, mode, controller.signal);
    const lines: string[] = [];
    policy.write(result, cli.flags.outputFormat, (line) => lines.push(line));
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(lines.join('\n') + '\n', (error) => (error ? reject(error) : resolve()));
    });
    return controller.signal.aborted ? 130 : result.exitCode;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

/**
 * The prompt `--prompt-file` names: the file's text (a relative path is read from the
 * working folder), or all of standard input for `-`. A prompt also given as text is refused.
 */
function readPromptFile(path: string, typed: string | undefined, workingDirectory: string): { readonly prompt: string } | { readonly error: string } {
  if (typed !== undefined) return { error: 'Give the prompt once: as text or with --prompt-file, not both.' };
  try {
    return { prompt: readFileSync(path === '-' ? 0 : resolve(workingDirectory, path), 'utf8') };
  } catch (error) {
    return { error: `--prompt-file could not read ${path === '-' ? 'standard input' : path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// The turn a headless command runs, shared by both terminal products.
export * from './headless-turn.js';
// A folder with nothing of its own to run is trusted the same way in `run` as at the interactive start.
export { headlessUntrustedFolderSentence, readFolderTrustFacts, settleHeadlessFolderTrust, trustFolderWithNothingOfItsOwn, type FolderTrustFacts } from './folder-trust.js';

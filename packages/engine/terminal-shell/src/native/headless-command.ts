import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { NativeHeadlessMode } from './native-headless-options.js';
import type { NativeHeadlessResult } from './native-headless.js';
export interface HeadlessCommandRuntime {
  readonly cli: {
    readonly flags: { readonly prompt?: string | undefined; readonly outputFormat: string;
      readonly continueLast?: boolean | undefined; readonly resume?: string | undefined; readonly session?: string | undefined };
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
  const prompt = cli.flags.prompt ?? (cli.positionals.length ? cli.positionals.join(' ') : undefined);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const result = await policy.run(prompt, mode, controller.signal);
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

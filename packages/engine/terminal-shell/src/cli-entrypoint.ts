import { headlessInvocationFromFlags, type HeadlessCliFlags, type HeadlessInvocation } from './native/native-headless-options.js';
export interface ShellEntrypointRoots {
  readonly defaultWorkingDirectory: string;
  readonly homeDirectory: string;
}
export interface ShellEntrypointOwnership {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}
export function resolveShellRoots(
  roots: ShellEntrypointRoots,
  workingDirOverride?: string,
  homeDirectory = roots.homeDirectory,
): ShellEntrypointOwnership {
  return { workingDirectory: workingDirOverride ?? roots.defaultWorkingDirectory, homeDirectory };
}
/**
 * Parse a terminal app's command line once, with the product's catalog, and
 * read the headless intake mode and `run` limits from the flags it parsed.
 */
export function parseNativeShellCli<
  Cli extends { readonly command: string; readonly errors: readonly string[]; readonly flags: HeadlessCliFlags },
>(
  argv: readonly string[],
  binary: string,
  parse: (argv: readonly string[], binary: string) => Cli,
): { readonly native: HeadlessInvocation; readonly cli: Cli } {
  const parsed = parse(argv, binary);
  const native = headlessInvocationFromFlags(parsed.flags);
  const nativeErrors = [...native.errors];
  if (native.mode !== 'submit' && parsed.command !== 'run') nativeErrors.push('Native intake recovery requires the run or exec command.');
  return { native, cli: { ...parsed, errors: [...parsed.errors, ...nativeErrors] } };
}
export type ShellMetadataResult = { readonly stdout?: string | undefined; readonly stderr?: string | undefined; readonly exitCode: number };
/** One parser precedence for the early metadata-only path and the full entrypoint. */
export function shellMetadataResult(
  cli: {
    readonly command: string;
    readonly commandArgs: readonly string[];
    readonly rawCommand?: string | null | undefined;
    readonly flags: { readonly help?: boolean | undefined; readonly version?: boolean | undefined };
  },
  binary: string,
  ports: {
    readonly help: (binary: string) => string;
    readonly commandHelp: (topic: string, binary: string) => string;
    readonly version: (binary: string) => string;
    /** `completion <shell>`: the script on stdout, or a usage refusal on stderr with exit 2. */
    readonly completion: (args: readonly string[], binary: string) => ShellMetadataResult;
  },
): ShellMetadataResult | null {
  if (cli.flags.help || cli.command === 'help') {
    const topic = cli.command === 'help' ? cli.commandArgs[0] : (cli.rawCommand ?? undefined);
    return { stdout: topic ? ports.commandHelp(topic, binary) : ports.help(binary), exitCode: 0 };
  }
  if (cli.flags.version || cli.command === 'version') return { stdout: ports.version(binary), exitCode: 0 };
  if (cli.command === 'completion') return ports.completion(cli.commandArgs, binary);
  return null;
}
/** Override errors are terminal before runtime construction, headless effects or command dispatch: written as text, then exit 2. */
export function requireValidCliOverrides(errors: readonly string[], write: (message: string) => void, exit: (code: number) => never): void {
  if (errors.length === 0) return;
  const result = cliUsageRefusalResult({ command: '', flags: {} }, errors, undefined);
  if (result?.stderr !== undefined) write(result.stderr);
  exit(2);
}

/** A `run` that was refused before it started, as the run's own result writer takes it. */
export interface CliUsageRunResult {
  readonly exitCode: 2;
  readonly response: '';
  readonly error: string;
  readonly stopReason: 'invalid-input';
}

export interface CliUsageRefusalPorts {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /**
   * The program's `run` result writer, loaded only when a `run` asked for JSON
   * is refused, so its answer has the one shape every `run` final frame has.
   */
  readonly loadRunResultWriter: () => Promise<(result: CliUsageRunResult, format: string, stdout: (line: string) => void) => void>;
}

type CliUsageRefusalCli = { readonly command: string; readonly flags: { readonly outputFormat?: string | undefined } };

const asksForJson = (cli: CliUsageRefusalCli): boolean => cli.flags.outputFormat === 'json' || cli.flags.outputFormat === 'stream-json';

/**
 * What a usage error prints (exit 2): the error lines and, when given, the one
 * usage line of the command, never the whole manual. With `--output json` or
 * `stream-json` it is one `{ok:false, kind:"usage", error, next}` document on
 * stdout instead. Undefined for a `run` that asked for JSON: its answer is the
 * run's own final frame, which {@link writeCliUsageRefusal} writes.
 */
export function cliUsageRefusalResult(cli: CliUsageRefusalCli, errors: readonly string[], usageLine: string | undefined): ShellMetadataResult | undefined {
  if (!asksForJson(cli)) return { stderr: [...errors, ...(usageLine ? [usageLine] : [])].join('\n'), exitCode: 2 };
  if (cli.command === 'run') return undefined;
  return { stdout: JSON.stringify({ ok: false, kind: 'usage', error: errors.join(' '), ...(usageLine ? { next: [usageLine] } : {}) }, null, 2), exitCode: 2 };
}

/**
 * Write a usage error (the caller exits 2): {@link cliUsageRefusalResult}, and
 * for a `run` that asked for JSON the run's final frame (`stopReason`
 * `invalid-input`), so it has the one shape every `run` final frame has.
 */
export async function writeCliUsageRefusal(
  cli: CliUsageRefusalCli,
  errors: readonly string[],
  usageLine: string | undefined,
  ports: CliUsageRefusalPorts,
): Promise<void> {
  const result = cliUsageRefusalResult(cli, errors, usageLine);
  if (result === undefined) {
    const write = await ports.loadRunResultWriter();
    write({ exitCode: 2, response: '', error: errors.join(' '), stopReason: 'invalid-input' }, cli.flags.outputFormat ?? 'json', ports.stdout);
    return;
  }
  if (result.stdout !== undefined) ports.stdout(result.stdout);
  if (result.stderr !== undefined) ports.stderr(result.stderr);
}
export function applyCliModelSelection(
  flags: { readonly provider?: string | undefined; readonly model?: string | undefined },
  ports: {
    readonly current: () => string;
    readonly provider: (model: string) => string;
    readonly model: (model: string) => string;
    readonly format: (provider: string, model: string) => string;
    readonly apply: (model: string) => void;
  },
): void {
  if (flags.provider === undefined && flags.model === undefined) return;
  const current = ports.current();
  ports.apply(ports.format(flags.provider ?? ports.provider(current), flags.model ?? ports.model(current)));
}

/**
 * Where a one-time startup notice is printed. A notice must never sit ahead of
 * machine-readable stdout, so `run` and any non-text output format send it to
 * stderr.
 */
export function startupNoticeWriter(
  cli: { readonly command: string | undefined; readonly flags: { readonly outputFormat?: string | undefined } },
  streams: { readonly out: (message: string) => void; readonly err: (message: string) => void },
): (message: string) => void {
  const machineReadable = cli.command === 'run' || (cli.flags.outputFormat !== undefined && cli.flags.outputFormat !== 'text');
  return machineReadable ? streams.err : streams.out;
}

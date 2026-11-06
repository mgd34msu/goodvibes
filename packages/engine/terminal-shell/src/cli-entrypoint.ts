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
export function parseNativeShellCli<
  Native extends { readonly argv: readonly string[]; readonly errors: readonly string[]; readonly mode: string },
  Cli extends { readonly command: string; readonly errors: readonly string[] },
>(
  argv: readonly string[],
  binary: string,
  extract: (argv: readonly string[]) => Native,
  parse: (argv: readonly string[], binary: string) => Cli,
) {
  const native = extract(argv);
  const parsed = parse(native.argv, binary);
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
    readonly completion: (shell: string | undefined, binary: string) => string;
  },
): ShellMetadataResult | null {
  if (cli.flags.help || cli.command === 'help') {
    const topic = cli.command === 'help' ? cli.commandArgs[0] : (cli.rawCommand ?? undefined);
    return { stdout: topic ? ports.commandHelp(topic, binary) : ports.help(binary), exitCode: 0 };
  }
  if (cli.flags.version || cli.command === 'version') return { stdout: ports.version(binary), exitCode: 0 };
  if (cli.command === 'completion') return { stdout: ports.completion(cli.commandArgs[0], binary), exitCode: 0 };
  return null;
}
/** Override errors are terminal before runtime construction, headless effects or command dispatch. */
export function requireValidCliOverrides(errors: readonly string[], write: (message: string) => void, exit: (code: number) => never): void {
  if (errors.length === 0) return;
  write(errors.join('\n'));
  exit(2);
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

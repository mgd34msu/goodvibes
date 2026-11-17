/**
 * Shell completion for every GoodVibes program (`goodvibes`, `goodvibes-agent`,
 * `goodvibes-daemon`), generated from a command table each program derives
 * from its own catalog, so a command or flag added there completes at once.
 *
 * What each script completes: the command word (names and aliases); after a
 * command, its sub-words in the position right after it and its flags plus
 * the global ones; the values of a flag that lists them; directories after a
 * directory flag. Anywhere else the shell's own file-name completion applies,
 * so a path argument still completes. Values that would have to be fetched (a
 * model, a session id) are not completed: a completion that waits on a socket
 * is worse than one that offers nothing.
 */
import type { CliCatalog, CommandFlagSpec } from './cli-catalog-types.js';

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string | undefined): value is CompletionShell {
  return typeof value === 'string' && (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** One flag: every spelling, whether it takes a value, and the values it lists. */
export interface CompletionFlagSpec {
  readonly tokens: readonly string[];
  readonly takesValue: boolean;
  readonly valueEnum?: readonly string[] | undefined;
  /** The value is a directory (completed as one). */
  readonly directory?: boolean | undefined;
  readonly description: string;
}

/** One command: its words, its sub-words and its own flags. */
export interface CompletionCommandSpec {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly subcommands: readonly string[];
  readonly flags?: readonly CompletionFlagSpec[] | undefined;
  /** Every word after this command is its own argument: the global flags go before it. */
  readonly passthrough?: boolean | undefined;
}

export interface CompletionTable {
  readonly binary: string;
  readonly commands: readonly CompletionCommandSpec[];
  readonly globalFlags: readonly CompletionFlagSpec[];
}

/** A catalog flag as a completion flag. */
export function completionFlagFromCatalog(flag: CommandFlagSpec<string>, directoryFlags: ReadonlySet<string> = new Set()): CompletionFlagSpec {
  return {
    tokens: flag.tokens,
    takesValue: flag.kind !== 'boolean' && flag.kind !== 'const',
    ...(flag.enumValues ? { valueEnum: flag.enumValues } : {}),
    ...(flag.tokens.some((token) => directoryFlags.has(token)) ? { directory: true } : {}),
    description: flag.summary,
  };
}

/**
 * A completion table derived from a CLI catalog. `describe` supplies a
 * command's one-line description and sub-words when the catalog does not carry
 * them (the terminal apps keep those in their help tables).
 */
export function completionTableFromCatalog(
  catalog: Pick<CliCatalog<string, string, unknown>, 'commands' | 'globalFlags'>,
  binary: string,
  options: {
    readonly describe?: ((name: string) => { readonly description?: string | undefined; readonly subcommands?: readonly string[] | undefined } | undefined) | undefined;
    readonly exclude?: ReadonlySet<string> | undefined;
    readonly hiddenFlags?: ReadonlySet<string> | undefined;
    readonly directoryFlags?: ReadonlySet<string> | undefined;
  } = {},
): CompletionTable {
  const directoryFlags = options.directoryFlags ?? new Set<string>();
  const visible = (flag: CommandFlagSpec<string>): boolean => !flag.tokens.some((token) => options.hiddenFlags?.has(token));
  return {
    binary,
    commands: catalog.commands
      .filter((spec) => !options.exclude?.has(spec.name))
      .map((spec) => {
        const described = options.describe?.(spec.name);
        return {
          name: spec.name,
          aliases: spec.aliases,
          description: described?.description ?? spec.summary ?? spec.name,
          subcommands: described?.subcommands ?? spec.subcommands,
          flags: spec.flags.filter(visible).map((flag) => completionFlagFromCatalog(flag, directoryFlags)),
          ...(spec.passthrough ? { passthrough: true } : {}),
        };
      }),
    globalFlags: catalog.globalFlags.filter(visible).map((flag) => completionFlagFromCatalog(flag, directoryFlags)),
  };
}

const ident = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, '_');
const words = (command: CompletionCommandSpec): readonly string[] => [command.name, ...command.aliases.filter((alias) => alias !== command.name)];
const flagTokens = (flags: readonly CompletionFlagSpec[]): string[] => [...new Set(flags.flatMap((flag) => flag.tokens))];
const commandFlags = (table: CompletionTable, command: CompletionCommandSpec): string[] =>
  flagTokens([...(command.flags ?? []), ...(command.passthrough ? [] : table.globalFlags)]);
const allFlags = (table: CompletionTable): CompletionFlagSpec[] => [...table.globalFlags, ...table.commands.flatMap((command) => command.flags ?? [])];
const shellWord = (value: string): string => value.replace(/[^A-Za-z0-9._:/@+=,-]/g, '');

function bashScript(table: CompletionTable): string {
  const fn = `_${ident(table.binary)}_complete`;
  const commandWords = table.commands.flatMap(words).map(shellWord).join(' ');
  const valueArms: string[] = [];
  const seen = new Set<string>();
  for (const flag of allFlags(table)) {
    if (!flag.takesValue) continue;
    const tokens = flag.tokens.filter((token) => !seen.has(token));
    if (tokens.length === 0) continue;
    for (const token of tokens) seen.add(token);
    const reply = flag.valueEnum
      ? `COMPREPLY=( $(compgen -W "${flag.valueEnum.map(shellWord).join(' ')}" -- "$cur") )`
      : flag.directory ? 'COMPREPLY=( $(compgen -d -- "$cur") )' : 'COMPREPLY=()';
    valueArms.push(`    ${tokens.join('|')}) ${reply}; return 0 ;;`);
  }
  const commandArms = table.commands.map((command) => [
    `    ${words(command).join('|')})`,
    `      flags="${commandFlags(table, command).join(' ')}"`,
    `      subs="${command.subcommands.map(shellWord).join(' ')}"`,
    '      ;;',
  ].join('\n'));
  return [
    `# bash completion for ${table.binary}, generated from its command catalog.`,
    `# Install: ${table.binary} completion bash > ~/.local/share/bash-completion/completions/${table.binary}`,
    '',
    `${fn}() {`,
    '  local cur="${COMP_WORDS[COMP_CWORD]}" prev="${COMP_WORDS[COMP_CWORD-1]}"',
    `  local commands="${commandWords}" global="${flagTokens(table.globalFlags).join(' ')}"`,
    '  local flags="" subs="" command="" at=0 i',
    '  case "$prev" in',
    ...valueArms,
    '  esac',
    '  for (( i=1; i < COMP_CWORD; i++ )); do',
    '    case "${COMP_WORDS[i]}" in -*) continue ;; esac',
    '    case " $commands " in *" ${COMP_WORDS[i]} "*) command="${COMP_WORDS[i]}"; at=$i; break ;; esac',
    '  done',
    '  if [[ -z "$command" ]]; then',
    '    if [[ "$cur" == -* ]]; then COMPREPLY=( $(compgen -W "$global" -- "$cur") )',
    '    else COMPREPLY=( $(compgen -W "$commands" -- "$cur") ); fi',
    '    return 0',
    '  fi',
    '  case "$command" in',
    ...commandArms,
    '  esac',
    '  if [[ "$cur" == -* ]]; then COMPREPLY=( $(compgen -W "$flags" -- "$cur") )',
    '  elif (( COMP_CWORD == at + 1 )) && [[ -n "$subs" ]]; then COMPREPLY=( $(compgen -W "$subs" -- "$cur") )',
    '  else COMPREPLY=(); fi',
    '  return 0',
    '}',
    '',
    // -o default: when the script offers nothing, bash completes file names.
    `complete -o default -F ${fn} ${table.binary}`,
    '',
  ].join('\n');
}

const zshQuote = (value: string): string => value.replace(/:/g, '\\:').replace(/'/g, "'\\''");

function zshScript(table: CompletionTable): string {
  const fn = `_${ident(table.binary)}`;
  const valueArms: string[] = [];
  const seen = new Set<string>();
  for (const flag of allFlags(table)) {
    if (!flag.takesValue) continue;
    const tokens = flag.tokens.filter((token) => !seen.has(token));
    if (tokens.length === 0) continue;
    for (const token of tokens) seen.add(token);
    const reply = flag.valueEnum ? `compadd -- ${flag.valueEnum.map(shellWord).join(' ')}` : flag.directory ? '_files -/' : '_files';
    valueArms.push(`    ${tokens.join('|')}) ${reply}; return ;;`);
  }
  const commandLines = table.commands.flatMap((command) => words(command).map((word) => `    '${zshQuote(word)}:${zshQuote(command.description)}'`));
  const commandArms = table.commands.map((command) => [
    `    ${words(command).join('|')})`,
    `      flags=(${commandFlags(table, command).map((token) => `'${zshQuote(token)}'`).join(' ')})`,
    `      subs=(${command.subcommands.map((sub) => `'${zshQuote(sub)}'`).join(' ')})`,
    '      ;;',
  ].join('\n'));
  return [
    `#compdef ${table.binary}`,
    `# zsh completion for ${table.binary}, generated from its command catalog.`,
    `# Install: ${table.binary} completion zsh > ~/.zfunc/_${table.binary}   (with ~/.zfunc on $fpath)`,
    '',
    `${fn}() {`,
    '  local -a commands flags subs',
    `  local -a global; global=(${flagTokens(table.globalFlags).map((token) => `'${zshQuote(token)}'`).join(' ')})`,
    '  case ${words[CURRENT-1]} in',
    ...valueArms,
    '  esac',
    '  commands=(',
    ...commandLines,
    '  )',
    '  local command="" at=0 i',
    '  for (( i=2; i < CURRENT; i++ )); do',
    '    [[ ${words[i]} == -* ]] && continue',
    '    if (( ${commands[(I)${words[i]}:*]} )); then command=${words[i]}; at=$i; break; fi',
    '  done',
    '  if [[ -z $command ]]; then',
    '    if [[ ${words[CURRENT]} == -* ]]; then compadd -a global; else _describe -t commands command commands; fi',
    '    return',
    '  fi',
    '  case $command in',
    ...commandArms,
    '  esac',
    '  if [[ ${words[CURRENT]} == -* ]]; then compadd -a flags',
    '  elif (( CURRENT == at + 1 && ${#subs} )); then compadd -a subs',
    '  else _files; fi',
    '}',
    '',
    `${fn} "$@"`,
    '',
  ].join('\n');
}

const fishQuote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function fishFlag(binary: string, condition: string, flag: CompletionFlagSpec): string[] {
  return flag.tokens.map((token) => {
    const option = token.startsWith('--') ? `-l ${token.slice(2)}` : `-s ${token.slice(1)}`;
    const value = flag.valueEnum
      ? ` -x -a ${fishQuote(flag.valueEnum.join(' '))}`
      : flag.directory ? ` -x -a '(__fish_complete_directories)'` : flag.takesValue ? ' -r' : '';
    return `complete -c ${binary}${condition} ${option}${value} -d ${fishQuote(flag.description)}`;
  });
}

function fishScript(table: CompletionTable): string {
  const binary = table.binary;
  const guard = `__${ident(binary)}_no_command`;
  const commandWords = table.commands.flatMap(words);
  const lines: string[] = [
    `# fish completion for ${binary}, generated from its command catalog.`,
    `# Install: ${binary} completion fish > ~/.config/fish/completions/${binary}.fish`,
    '',
    `function ${guard}`,
    '  set -l tokens (commandline -opc)',
    '  set -e tokens[1]',
    '  for token in $tokens',
    `    if contains -- $token ${commandWords.map(shellWord).join(' ')}`,
    '      return 1',
    '    end',
    '  end',
    '  return 0',
    'end',
    '',
  ];
  for (const command of table.commands) {
    for (const word of words(command)) {
      lines.push(`complete -c ${binary} -n '${guard}' -a ${fishQuote(word)} -d ${fishQuote(command.description)}`);
    }
  }
  for (const command of table.commands) {
    const seen = `__fish_seen_subcommand_from ${words(command).map(shellWord).join(' ')}`;
    // Sub-words only right after the command word.
    const first = `${seen}; and test (count (commandline -opc)) -le 2`;
    for (const sub of command.subcommands) lines.push(`complete -c ${binary} -n ${fishQuote(first)} -a ${fishQuote(sub)}`);
    for (const flag of command.flags ?? []) lines.push(...fishFlag(binary, ` -n ${fishQuote(seen)}`, flag));
  }
  const passthroughWords = table.commands.filter((command) => command.passthrough).flatMap(words);
  const globalCondition = passthroughWords.length > 0 ? ` -n ${fishQuote(`not __fish_seen_subcommand_from ${passthroughWords.map(shellWord).join(' ')}`)}` : '';
  for (const flag of table.globalFlags) lines.push(...fishFlag(binary, globalCondition, flag));
  lines.push('');
  return lines.join('\n');
}

export function renderCompletionScript(shell: CompletionShell, table: CompletionTable): string {
  if (shell === 'bash') return bashScript(table);
  if (shell === 'zsh') return zshScript(table);
  return fishScript(table);
}

export interface CompletionCommandResult {
  readonly exitCode: number;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

/**
 * `<binary> completion <shell>`. A missing or unsupported shell is a usage
 * refusal (exit 2, on stderr) naming the shells that exist: a bash script
 * installed for another shell silently never fires.
 */
export function runCompletionCommand(args: readonly string[], table: CompletionTable): CompletionCommandResult {
  const positional = args.filter((token) => !token.startsWith('-'));
  const usage = `  ${table.binary} completion ${COMPLETION_SHELLS.join('|')}`;
  const shell = positional[0]?.toLowerCase();
  if (shell === undefined) return { exitCode: 2, stderr: ['completion: name the shell. Supported: bash, zsh, fish.', usage].join('\n') };
  if (!isCompletionShell(shell)) {
    return { exitCode: 2, stderr: [`completion: '${positional[0]}' is not supported. Supported: bash, zsh, fish.`, usage].join('\n') };
  }
  if (positional.length > 1) return { exitCode: 2, stderr: [`completion: '${positional[1]}' is one argument too many.`, usage].join('\n') };
  return { exitCode: 0, stdout: renderCompletionScript(shell, table) };
}

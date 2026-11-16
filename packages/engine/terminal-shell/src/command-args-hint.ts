/** A command's own argument hints, one per subcommand, declared beside its handler. */
export interface CommandSubcommandHints {
  readonly subcommands?: Readonly<Record<string, string>> | undefined;
}

/**
 * Hints for shared commands whose definitions do not yet declare `subcommands`.
 * Keyed by the command's primary name. A command's own `subcommands` wins.
 */
export const COMMON_SUBCOMMAND_HINTS = {
  template: { save: '<name>', use: '<name> [args]', edit: '<name>', delete: '<name>' },
  plugin: { enable: '<name>', disable: '<name>', reload: '' },
} as const;

/**
 * The hint the composer shows after `/command` or `/command subcommand `.
 * The command is resolved through the registry, so an alias gets the same
 * hints as the primary name.
 */
export function buildCommandArgsHint(
  prompt: string,
  commandRegistry: {
    get(name: string): ({ readonly name: string; readonly argsHint?: string | undefined; readonly usage?: string | undefined } & CommandSubcommandHints) | undefined;
  },
  fallbackHints: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): string | undefined {
  if (!prompt.startsWith('/')) return undefined;

  const spaceIdx = prompt.indexOf(' ');
  if (spaceIdx === -1) {
    const cmd = commandRegistry.get(prompt.slice(1));
    return cmd?.argsHint ?? cmd?.usage;
  }

  const cmd = commandRegistry.get(prompt.slice(1, spaceIdx));
  if (!cmd) return undefined;

  const afterCmd = prompt.slice(spaceIdx + 1);
  if (afterCmd.includes(' ')) return undefined;

  const subMap = cmd.subcommands ?? fallbackHints[cmd.name];
  if (subMap && Object.hasOwn(subMap, afterCmd)) return subMap[afterCmd];
  return undefined;
}

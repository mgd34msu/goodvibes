export const COMMON_SUBCOMMAND_HINTS = {
  template: { save: '<name>', use: '<name> [args]', edit: '<name>', delete: '<name>' },
  secrets: { set: '<KEY> <value>', get: '<KEY>', delete: '<KEY>' },
  permissions: { tool: '<name> allow|prompt|deny' },
  config: { reset: '<key>' },
  plugin: { enable: '<name>', disable: '<name>', reload: '' },
} as const;
export function buildCommandArgsHint(
  prompt: string,
  commandRegistry: { get(name: string): { readonly argsHint?: string | undefined; readonly usage?: string | undefined } | undefined },
  subcommandHints: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | undefined {
  if (!prompt.startsWith('/')) return undefined;

  const spaceIdx = prompt.indexOf(' ');
  if (spaceIdx === -1) {
    const cmd = commandRegistry.get(prompt.slice(1));
    return cmd?.argsHint ?? cmd?.usage;
  }

  const cmdName = prompt.slice(1, spaceIdx);
  const cmd = commandRegistry.get(cmdName);
  if (!cmd) return undefined;

  const afterCmd = prompt.slice(spaceIdx + 1);
  const subSpaceIdx = afterCmd.indexOf(' ');
  if (subSpaceIdx !== -1) return undefined;

  const subMap = subcommandHints[cmdName];
  if (subMap && Object.hasOwn(subMap, afterCmd)) return subMap[afterCmd];
  return undefined;
}

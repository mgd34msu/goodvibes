/**
 * The shell command text an exec-style call carries, read the way the exec
 * tool reads it: `cmd_base64` wins over `cmd`. Permission rules and the safety
 * check judge exactly the text that would run, never a decoy `cmd` beside a
 * different `cmd_base64`.
 */

/** The text(s) one `commands` entry would run. Both texts when `cmd` and `cmd_base64` disagree, so a rule never vouches for one while the other runs. */
export function execEntryTexts(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const record = entry as Record<string, unknown>;
  const rawCmd = record['cmd'];
  const rawEncoded = record['cmd_base64'];
  const cmd = typeof rawCmd === 'string' ? rawCmd : undefined;
  const encoded = typeof rawEncoded === 'string' && rawEncoded.length > 0
    ? Buffer.from(rawEncoded, 'base64').toString('utf-8')
    : undefined;
  if (encoded !== undefined) return cmd !== undefined && cmd.length > 0 && cmd !== encoded ? [encoded, cmd] : [encoded];
  return cmd !== undefined ? [cmd] : [];
}

/** Every command text in a `commands` list, or an empty list when the call has none. */
export function execListedCommandTexts(args: Record<string, unknown>): string[] {
  const commands = args['commands'];
  return Array.isArray(commands) ? commands.flatMap(execEntryTexts) : [];
}

/** The shell commands a call carries: a `commands` list of `{ cmd | cmd_base64 }`, or a flat `command` / `cmd`. */
export function execShellCommands(args: Record<string, unknown>): string[] {
  const listed = execListedCommandTexts(args);
  if (listed.length > 0) return listed;
  for (const key of ['command', 'cmd']) if (typeof args[key] === 'string') return [args[key] as string];
  return [];
}

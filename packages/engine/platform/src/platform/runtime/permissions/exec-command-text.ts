/**
 * The shell command text an exec-style call carries, read the way the exec
 * tool reads it: `cmd_base64` wins over `cmd`. This module is the one reading
 * of an entry: the exec runtime runs `execCommandText`, and permission rules,
 * the safety check and approval cards judge `execEntryTexts`, so nothing is
 * judged by a decoy `cmd` beside a different `cmd_base64`.
 */

/** Shown in place of an entry whose `cmd_base64` is malformed; the exec tool refuses to run it. */
export const INVALID_CMD_BASE64_TEXT = '(cmd_base64 is not valid base64)';

/** Whether `value` is standard base64 (padding optional), so a malformed command is refused rather than half-decoded. */
export function isExecBase64(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  return /^[A-Za-z0-9+/]*={0,2}$/.test(compact) && compact.replace(/=+$/, '').length % 4 !== 1;
}

/**
 * The command text one exec entry runs: `cmd_base64` decoded when present, else
 * `cmd`. Throws when neither is given, when the base64 is malformed, or when
 * both are given and disagree, so no entry can run text other than the text it
 * shows.
 */
export function execCommandText(entry: { readonly cmd?: string | undefined; readonly cmd_base64?: string | undefined }): string {
  const { cmd, cmd_base64: encoded } = entry;
  if (encoded) {
    if (!isExecBase64(encoded)) throw new Error('cmd_base64 is not valid base64; nothing was run');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    if (cmd && cmd !== decoded) throw new Error('A command entry gave both cmd and cmd_base64 with different text; give one of them. Nothing was run.');
    return decoded;
  }
  if (cmd) return cmd;
  throw new Error('Each command must have either cmd or cmd_base64');
}

/**
 * The text(s) a reader judges for one `commands` entry. Both texts when `cmd`
 * and `cmd_base64` disagree (the exec tool refuses that entry), so a rule never
 * vouches for one of them; a malformed `cmd_base64` is named, never decoded.
 */
export function execEntryTexts(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const record = entry as Record<string, unknown>;
  const rawCmd = record['cmd'];
  const rawEncoded = record['cmd_base64'];
  const cmd = typeof rawCmd === 'string' ? rawCmd : undefined;
  if (typeof rawEncoded === 'string' && rawEncoded.length > 0) {
    if (!isExecBase64(rawEncoded)) return [INVALID_CMD_BASE64_TEXT];
    const encoded = Buffer.from(rawEncoded, 'base64').toString('utf-8');
    return cmd !== undefined && cmd.length > 0 && cmd !== encoded ? [encoded, cmd] : [encoded];
  }
  return cmd !== undefined ? [cmd] : [];
}

/** Every command text in a `commands` list, or an empty list when the call has none. */
export function execListedCommandTexts(args: Record<string, unknown>): string[] {
  const commands = args['commands'];
  return Array.isArray(commands) ? commands.flatMap(execEntryTexts) : [];
}

/**
 * The shell commands a call carries: a `commands` list of `{ cmd | cmd_base64 }`,
 * a flat `command` / `cmd`, or a command the call installs to run later (a
 * workflow schedule's `scheduleCommand`, a hook action's
 * `hookActionDefinition.action`). An installed command is judged as a command
 * when it is added, by the same gate questions an exec call gets, because
 * nothing asks again when it runs.
 */
export function execShellCommands(args: Record<string, unknown>): string[] {
  const listed = execListedCommandTexts(args);
  if (listed.length > 0) return listed;
  for (const key of ['command', 'cmd']) if (typeof args[key] === 'string') return [args[key] as string];
  return installedCommandTexts(args);
}

function installedCommandTexts(args: Record<string, unknown>): string[] {
  const scheduled = args['scheduleCommand'];
  if (typeof scheduled === 'string' && scheduled.trim().length > 0) return [scheduled];
  const hookAction = args['hookActionDefinition'];
  const action = hookAction && typeof hookAction === 'object' ? (hookAction as Record<string, unknown>)['action'] : undefined;
  return typeof action === 'string' && action.trim().length > 0 ? [action] : [];
}

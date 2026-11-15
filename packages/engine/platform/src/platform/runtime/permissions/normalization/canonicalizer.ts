/**
 * Canonicalizer, resolves raw command tokens to their canonical command names.
 *
 * Strips:
 *  - Absolute and relative path prefixes (e.g. /usr/bin/rm → rm)
 *  - Environment variable assignments that prefix the command
 *    (e.g. FOO=bar git → git)
 *  - Quoted wrappers around the command name
 *
 * Returns the lowercase bare command name, or an empty string if the
 * input cannot be resolved.
 */

/** Pattern for an environment variable assignment (KEY=value). */
const ENV_VAR_PREFIX = /^[A-Z_][A-Z0-9_]*=/i;

/**
 * True for a `KEY=value` environment assignment token. A command line's first
 * word is not the command while it is one of these: the command is the next
 * word that is not.
 */
export function isEnvAssignmentToken(token: string): boolean {
  return ENV_VAR_PREFIX.test(token);
}

/**
 * Strips shell quoting (single or double) from a string.
 *
 * @param value - The raw token value, potentially quoted.
 * @returns The unquoted string value.
 */
function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Resolves `\x` to `x` outside quotes, as the shell does, so `\rm` names `rm`. */
function unescapeBackslashes(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Resolves a raw command token to its canonical bare command name.
 *
 * Processing order:
 *  1. A fully quoted token is one word: its content, spaces included, is the
 *     command name. Otherwise backslash escapes are resolved and the text is
 *     read as space-separated words.
 *  2. Skip leading environment variable assignments (unquoted input only).
 *  3. Extract the basename (strip directory path).
 *  4. Lowercase the result.
 *
 * A lone assignment (`FOO=bar`) is not a command; it is returned as it is so
 * the caller can see it and look for the command in the following token.
 *
 * @param raw - The raw command token value.
 * @returns The canonical command name (e.g. "rm", "git", "npm").
 */
export function canonicalize(raw: string): string {
  if (!raw) return '';

  const unquoted = stripQuotes(raw);
  let commandPart: string;
  if (unquoted !== raw) {
    commandPart = unquoted;
  } else {
    const parts = raw.split(/(?<!\\)\s+/).map(unescapeBackslashes).filter((part) => part !== '');
    // Walk forward past any KEY=value segments
    commandPart = parts[0] ?? '';
    for (const part of parts) {
      if (!isEnvAssignmentToken(part)) {
        commandPart = part;
        break;
      }
    }
  }

  // Extract basename from path (e.g. /usr/bin/git → git, ./scripts/deploy.sh → deploy.sh)
  const lastSlash = commandPart.lastIndexOf('/');
  if (lastSlash !== -1) {
    commandPart = commandPart.slice(lastSlash + 1);
  }

  return commandPart.toLowerCase();
}

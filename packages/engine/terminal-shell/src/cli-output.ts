import { formatRefusal, type CommandResult } from '@goodvibes/engine/errors';
export function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}
/** The value as JSON when `--output json` was asked for, else the text. */
export function formatJsonOrText(cli: {
  readonly flags: { readonly outputFormat?: string | undefined };
}): (value: unknown, text: string) => string {
  return (value, text) => (cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text);
}

/** A refusal code that means the command line itself was wrong; it exits 2. */
export const CLI_USAGE_REFUSAL_CODE = 'USAGE';

/**
 * What a management command prints and the exit code it ends with, from its
 * typed result, never from its wording: 0 when it happened, 2 for a usage
 * refusal, 1 for any other refusal (docs/exit-codes.md). Under `--output json`
 * a refusal prints as JSON as well (`ok: false` with state, reason and next
 * steps), so a script that asked for JSON always gets JSON.
 */
export function renderCliCommandResult(
  runtime: { readonly cli: { readonly flags: { readonly outputFormat?: string | undefined } } },
  result: CommandResult,
  data?: unknown,
): { readonly output: string; readonly exitCode: number } {
  const json = runtime.cli.flags.outputFormat === 'json';
  if (result.ok) {
    return { output: json && data !== undefined ? JSON.stringify(data, null, 2) : result.lines.join('\n'), exitCode: 0 };
  }
  const refusal = result.refusal;
  return {
    output: json
      ? JSON.stringify({ ok: false, code: refusal.code, state: refusal.state, reason: refusal.reason, next: refusal.next }, null, 2)
      : formatRefusal(refusal),
    exitCode: refusal.code === CLI_USAGE_REFUSAL_CODE ? 2 : 1,
  };
}

/** What a CLI command printed and the exit code its outcome decided (docs/exit-codes.md). */
export interface CliCommandOutput {
  readonly output: string;
  readonly exitCode: number;
}

/** The kind of a refusal caused by the command line itself; it exits 2. */
export const CLI_USAGE_REFUSAL_KIND = 'usage';

/** The command did what it says: exit 0. */
export function cliCommandDone(output: string): CliCommandOutput {
  return { output, exitCode: 0 };
}

/**
 * A refusal, decided where the command knows it: the sentence at a terminal,
 * `{ ok: false, kind, error, next? }` under `--output json`, so a script that
 * asked for JSON gets JSON. Kind `usage` exits 2, any other kind exits 1.
 */
export function cliCommandRefusal(
  cli: { readonly flags: { readonly outputFormat?: string | undefined } },
  kind: string,
  error: string,
  next?: readonly string[],
): CliCommandOutput {
  const json = cli.flags.outputFormat === 'json';
  return {
    output: json ? JSON.stringify({ ok: false, kind, error, ...(next && next.length > 0 ? { next } : {}) }, null, 2) : error,
    exitCode: kind === CLI_USAGE_REFUSAL_KIND ? 2 : 1,
  };
}

export function commandJsonOrText(
  runtime: { readonly cli: { readonly flags: { readonly outputFormat?: string | undefined } } },
  value: unknown,
  text: string,
): string {
  return formatJsonOrText(runtime.cli)(value, text);
}

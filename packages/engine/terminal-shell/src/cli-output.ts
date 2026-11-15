import { formatRefusal, type CommandResult } from '@goodvibes-jev/engine/errors';
import { formatJsonOrText as formatOutput } from './support-bundle-inspection.js';
export function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}
export function formatJsonOrText(cli: {
  readonly flags: { readonly outputFormat?: string | undefined };
}): (value: unknown, text: string) => string {
  return (value, text) => formatOutput({ cli }, value, text);
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

/** Legacy text-command status mapping, with product-specific prefixes supplied at construction. Used only by handlers that still return text; a handler that returns a `CommandResult` goes through `renderCliCommandResult`. */
export function commandTextExitCode(output: string, usagePrefixes: readonly string[], failurePrefixes: readonly string[]): number {
  if (usagePrefixes.some((prefix) => output.startsWith(prefix))) return 2;
  if (failurePrefixes.some((prefix) => output.startsWith(prefix))) return 1;
  if (['No stored ', 'No pending ', 'No model ', 'No provider ', 'No auth ', 'No subscription ', 'Unknown ', 'Ambiguous ', 'Not stored', 'Session not found'].some((prefix) => output.startsWith(prefix)))
    return 1;
  return output === 'Bundle has no config object to import.' ? 1 : 0;
}

export function commandJsonOrText(
  runtime: { readonly cli: { readonly flags: { readonly outputFormat?: string | undefined } } },
  value: unknown,
  text: string,
): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

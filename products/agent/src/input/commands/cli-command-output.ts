/**
 * How a slash command that reuses a CLI handler reports the handler's answer:
 * a non-zero exit is a refusal (the same exit a script reads as failure), so a
 * failed or refused run is never shown to the workspace or the model as a
 * command that ran and printed.
 */
import type { CliCommandOutput } from '../../cli/types.ts';
import { commandRefusal } from './confirmation.ts';

/** Refuse a line the CLI parser did not accept, instead of printing its errors as output. */
export function refuseCliParseErrors(errors: readonly string[]): void {
  if (errors.length > 0) throw commandRefusal(errors.join('\n'), undefined, 'USAGE');
}

/** Print a successful CLI handler's output; throw its output as a refusal when it exited non-zero. */
export function printCliCommandResult(print: (text: string) => void, result: CliCommandOutput): void {
  if (result.exitCode !== 0) {
    // Exit 2 is a usage or confirmation refusal; anything else is a failure.
    const code = result.exitCode !== 2 ? 'COMMAND_FAILED' : result.output.startsWith('Refusing') ? 'CONFIRMATION_REQUIRED' : 'USAGE';
    throw commandRefusal(result.output, undefined, code);
  }
  print(result.output);
}

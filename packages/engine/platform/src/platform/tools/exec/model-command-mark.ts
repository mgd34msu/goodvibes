/**
 * model-command-mark.ts, the mark a model's command tool puts on every command it runs: an environment variable set
 * after the command's own environment is merged, so a call cannot clear it by naming it. A GoodVibes program started by
 * such a command (`goodvibes do`) reads it and does not say a person asked (terminal-shell capability-cli.ts). The mark
 * is a hint for that program only: a command can still unset it inside its own shell, which is why the program also
 * needs a terminal at its standard input before it makes that claim, and why the gate asks the owner before a model's
 * command runs one of the product's own programs (gate/product-commands.ts).
 */
export const MODEL_COMMAND_MARK = 'GOODVIBES_COMMAND_FROM_MODEL';

/** A command's environment with the mark set last. */
export function withModelCommandMark(env: Record<string, string>): Record<string, string> {
  return { ...env, [MODEL_COMMAND_MARK]: '1' };
}

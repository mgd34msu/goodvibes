/**
 * model-command-mark.ts, the mark a model's command tool puts on every command it runs: an environment variable set
 * after the command's own environment is merged, so a call cannot clear it by naming it. Nothing decides by it: a
 * command can unset it inside its own shell. A `do` is never a person's press whatever its environment (it registers as
 * a command line, daemon/program-registrations.ts), and the gate asks the owner, in every mode, before a model's command
 * runs one of the product's own programs or names one of its marks (gate/product-commands.ts `PRODUCT_MARK`).
 */
export const MODEL_COMMAND_MARK = 'GOODVIBES_COMMAND_FROM_MODEL';

/** A command's environment with the mark set last. */
export function withModelCommandMark(env: Record<string, string>): Record<string, string> {
  return { ...env, [MODEL_COMMAND_MARK]: '1' };
}

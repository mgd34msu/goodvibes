/**
 * The words of the script form of find and run (capability-cli.ts), apart
 * from it so a program's help and argument parsing load nothing else.
 */
export const CAPABILITY_CLI_VERBS = ['do', 'find'] as const;
export type CapabilityCliVerb = (typeof CAPABILITY_CLI_VERBS)[number];

export const CAPABILITY_DO_USAGE = 'do <capability id> [--input key=value ...] [--output json]';
export const CAPABILITY_FIND_USAGE = 'find "<what you need>" [--output json]';

/** The help pages of the two verbs, the same in every program. */
export const CAPABILITY_CLI_HELP: Readonly<Record<CapabilityCliVerb, { readonly usage: readonly string[]; readonly summary: string; readonly line: string; readonly examples: readonly string[] }>> = {
  do: {
    usage: [CAPABILITY_DO_USAGE],
    summary: 'Run one GoodVibes capability by its id (from find) with its inputs, through the daemon. A command you typed is the request, so it runs at once and prints what it did; a capability that acts on a conversation is refused here (it runs in the terminal app or the Agent). Exit 0 done, 1 refused or failed, 2 bad usage.',
    line: 'Run a capability by id (from find) with --input key=value',
    examples: ['do hooks.disable --input hook=lint-before-commit', 'do secrets.set --input key=STRIPE_KEY --input value=... --input scope=user', 'do memory.explain --input task="add a login page" --output json'],
  },
  find: {
    usage: [CAPABILITY_FIND_USAGE],
    summary: 'Say what you need in words: three to five capabilities come back with their ids, inputs and risk, from the function group that serves the need. Nothing runs.',
    line: 'Find the capabilities that do what you need',
    examples: ['find "switch off the lint hook"', 'find "store my stripe key" --output json'],
  },
};

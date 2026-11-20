/**
 * `/owner-profile`, read, trace, correct and delete what the platform knows
 * about him, from inside a session.
 *
 * A thin wrapper over the same `handleOwnerProfileCommand` the top-level CLI
 * runs, in the shape `/health compat` (health-runtime.ts) uses: parse, build a
 * `CliCommandRuntime`, print the result. One implementation, so the shell and
 * the shell-less binary can never answer differently, which matters more here
 * than usual, because "what do you know about me" and "where did you get that"
 * have to mean the same thing wherever he asks them.
 *
 * Named `owner-profile` rather than `profile` for the reason the CLI command is:
 * `profile` already means the isolated Agent profile homes, and breaking a
 * working command to win a name is a bad trade.
 *
 * This command's output lands in the transcript, which is model context, so it
 * asks the handler for the counted rendering of the People section rather than
 * the listed one (§10); `person <name>` is the way through. The same handler run
 * from a shell prints his full list, because nothing there reaches a model.
 */

import type { CliCommandRuntime } from '../../cli/management.ts';
import { handleOwnerProfileCommand } from '../../cli/owner-profile-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { READ_VERB, ownerOnlyVerb, withCommandVerbs, type CommandVerbs } from './command-verbs.ts';
import { requireShellPaths } from './runtime-services.ts';
import { printCliCommandResult, refuseCliParseErrors } from './cli-command-output.ts';

/**
 * A write here presents the owner's own credential and is recorded as his own
 * words (owner-direct), so it counts only when he types it. The model records
 * a fact with its `profile` tool, under its delegated authority and with its
 * own provenance, which the daemon checks on its own terms.
 */
const PROFILE_WRITE_VERB = ownerOnlyVerb(
  'outward',
  'writes your profile as your own words, with your own credential',
  'Use the profile tool (action set, append, undo or forget): it writes under the Agent\'s delegated authority and records where the fact came from',
);

const OWNER_PROFILE_VERBS: CommandVerbs = {
  defaultVerb: 'read',
  verbs: {
    read: READ_VERB, show: READ_VERB, list: READ_VERB,
    get: READ_VERB, field: READ_VERB, person: READ_VERB,
    provenance: READ_VERB, source: READ_VERB, where: READ_VERB, status: READ_VERB,
    set: PROFILE_WRITE_VERB, note: PROFILE_WRITE_VERB, append: PROFILE_WRITE_VERB, undo: PROFILE_WRITE_VERB,
    forget: PROFILE_WRITE_VERB, delete: PROFILE_WRITE_VERB, remove: PROFILE_WRITE_VERB,
  },
  // An unknown verb prints the usage and changes nothing.
  otherwise: READ_VERB,
};

export function registerOwnerProfileRuntimeCommands(registry: CommandRegistry): void {
  registry.register(withCommandVerbs({
    name: 'owner-profile',
    effect: 'mixed',
    aliases: ['about-me'],
    description: 'Your profile: read it, see where a fact came from, correct one, or forget one',
    usage: '[read|get <fieldId>|person <name>|provenance <fieldId>|set <fieldId> <value> --yes|note --section <section> --text <line> --yes|undo <fieldId> --yes|forget <fieldId> --yes|status]',
    argsHint: 'read|get|person|provenance|set|note|undo|forget|status',
    async handler(args, ctx) {
      const cli = parseGoodVibesCli(['owner-profile', ...args], 'goodvibes-agent');
      refuseCliParseErrors(cli.errors);

      const shellPaths = requireShellPaths(ctx);
      const runtime: CliCommandRuntime = {
        cli,
        configManager: ctx.platform.configManager,
        workingDirectory: shellPaths.workingDirectory,
        homeDirectory: shellPaths.homeDirectory,
      };
      // Printed output is display only; it reaches the model only as the tool
      // result of a model-run command, which is when the People section is
      // shown as a count instead of a list.
      const result = await handleOwnerProfileCommand(runtime, { outputEntersModelContext: ctx.invokedByModel === true });
      printCliCommandResult((text) => ctx.print(text), result);
    },
  }, OWNER_PROFILE_VERBS));
}

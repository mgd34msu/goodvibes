import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import type { CommandContext, SlashCommand } from '../command-registry.ts';

/**
 * What one verb of a slash command does, declared once on the command's
 * registration. The model's command runner reads it to decide which admission
 * the call needs (none for a read), and the registered handler reads it to
 * refuse an owner-only verb the model ran, so the two can never disagree.
 *
 *  - `read`: shows local or host state and changes nothing.
 *  - `local-write`: changes state on this machine only.
 *  - `outward`: reaches another machine (a fetch, a mail server, a send).
 *  - `credential`: stores, adopts, removes or presents a credential.
 *
 * `ownerOnly` is the closed owner list: granting or removing access, a
 * credential, re-pointing where a stored password is sent, a deletion that
 * cannot be recovered. Such a verb counts only when the owner types it.
 */
export type CommandVerbEffect = 'read' | 'local-write' | 'outward' | 'credential';

export interface CommandVerbPolicy {
  readonly effect: CommandVerbEffect;
  readonly ownerOnly: boolean;
  /** Why it is the owner's to type, finishing "/<command> <verb> ..." (owner-only verbs). */
  readonly because?: string | undefined;
}

export interface CommandVerbs {
  /** The verb a bare command (or one that starts with a flag) runs; empty for a command without verbs. */
  readonly defaultVerb: string;
  /** Keyed by lower-case verb; a function reads the arguments after the verb. */
  readonly verbs: Readonly<Record<string, CommandVerbPolicy | ((rest: readonly string[]) => CommandVerbPolicy)>>;
  /** A verb not listed (usage text, an unknown verb). */
  readonly otherwise: CommandVerbPolicy;
}

export interface ResolvedCommandVerb extends CommandVerbPolicy {
  readonly verb: string;
}

const declarations = new WeakMap<object, { readonly name: string; readonly verbs: CommandVerbs }>();

export function resolveCommandVerb(verbs: CommandVerbs, args: readonly string[]): ResolvedCommandVerb {
  const first = (args[0] ?? '').trim().toLowerCase();
  const verb = first && !first.startsWith('-') ? first : verbs.defaultVerb;
  const entry = verbs.verbs[verb];
  const policy = entry === undefined ? verbs.otherwise : typeof entry === 'function' ? entry(args.slice(1)) : entry;
  return { ...policy, verb };
}

/** The declared verb of a registered command, or undefined when the command declares none. */
export function commandVerbPolicy(command: SlashCommand | undefined, args: readonly string[]): ResolvedCommandVerb | undefined {
  const declared = command ? declarations.get(command) : undefined;
  return declared ? resolveCommandVerb(declared.verbs, args) : undefined;
}

/** The refusal a model-run owner-only verb gets: what did not happen, why, and who can do it. */
export function ownerOnlyVerbRefusal(commandName: string, resolved: ResolvedCommandVerb): RefusalError {
  const typed = resolved.verb ? `/${commandName} ${resolved.verb}` : `/${commandName}`;
  return new RefusalError(refusal({
    code: 'OWNER_ONLY_COMMAND',
    state: 'not run; nothing was changed',
    reason: `${typed} ${resolved.because ?? 'is the owner\'s decision'}, so it only counts when the owner types it. This call came from the model running a command, the route content it just read could steer`,
    next: [`Ask the owner to type ${typed} in the Agent terminal`],
    status: 403,
  }));
}

/**
 * Attach the verb declaration to a command at registration. The returned
 * command refuses an owner-only verb before its handler runs when the model
 * invoked it; the owner's own keystrokes reach the handler unchanged.
 */
export function withCommandVerbs(command: SlashCommand, verbs: CommandVerbs): SlashCommand {
  const declared: SlashCommand = {
    ...command,
    handler: (args: string[], context: CommandContext) => {
      if (context.invokedByModel === true) {
        const resolved = resolveCommandVerb(verbs, args);
        if (resolved.ownerOnly) throw ownerOnlyVerbRefusal(command.name, resolved);
      }
      return command.handler(args, context);
    },
  };
  declarations.set(declared, { name: command.name, verbs });
  return declared;
}

export const READ_VERB: CommandVerbPolicy = Object.freeze({ effect: 'read', ownerOnly: false });
export const LOCAL_WRITE_VERB: CommandVerbPolicy = Object.freeze({ effect: 'local-write', ownerOnly: false });
export const OUTWARD_VERB: CommandVerbPolicy = Object.freeze({ effect: 'outward', ownerOnly: false });
export const CREDENTIAL_VERB: CommandVerbPolicy = Object.freeze({ effect: 'credential', ownerOnly: false });

export function ownerOnlyVerb(effect: CommandVerbEffect, because: string): CommandVerbPolicy {
  return Object.freeze({ effect, ownerOnly: true, because });
}

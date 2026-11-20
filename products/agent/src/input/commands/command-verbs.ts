import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { ownerOnlyFor, parseTypedLine, type ActionTouches } from '@goodvibes-jev/engine/terminal-shell/command-actions';
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
  /** What the model can do itself instead, when a tool of its own does the job under its own authority. */
  readonly instead?: string | undefined;
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

const TOUCHES_EFFECT: Readonly<Record<ActionTouches, CommandVerbEffect>> = {
  reads: 'read',
  'this-machine': 'local-write',
  'another-machine': 'outward',
  credential: 'credential',
};

/**
 * A described command's policy for a line, read from its description: what the
 * action touches, and whether only the owner may run it (declared, or a value
 * that loosens a protection). A bare command runs its report; a word the
 * command does not know reads nothing (the handler refuses it).
 */
function describedVerbPolicy(command: SlashCommand, args: readonly string[]): ResolvedCommandVerb | undefined {
  const described = command.described;
  if (!described) return undefined;
  const parsed = parseTypedLine(described, args);
  if ('bare' in parsed) {
    const report = described.actions.find((action) => action.id === described.report);
    return { verb: report?.word ?? '', effect: report ? TOUCHES_EFFECT[report.touches] : 'read', ownerOnly: false };
  }
  if ('unknownWord' in parsed) return { verb: parsed.unknownWord.toLowerCase(), effect: 'read', ownerOnly: false };
  const owner = ownerOnlyFor(parsed.action, parsed.values);
  return {
    verb: parsed.action.word,
    effect: TOUCHES_EFFECT[parsed.action.touches],
    ownerOnly: owner !== undefined,
    ...(owner ? { because: `(${parsed.action.label}) is the owner's own act: ${owner.reason}`, ...(owner.instead ? { instead: owner.instead } : {}) } : {}),
  };
}

/** The declared verb of a registered command, or undefined when the command declares none. */
export function commandVerbPolicy(command: SlashCommand | undefined, args: readonly string[]): ResolvedCommandVerb | undefined {
  const described = command ? describedVerbPolicy(command, args) : undefined;
  if (described) return described;
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
    next: [`Ask the owner to type ${typed} in the Agent terminal`, ...(resolved.instead ? [resolved.instead] : [])],
    status: 403,
  }));
}

/**
 * Attach the verb declaration to a command at registration. The returned
 * command refuses an owner-only verb before its handler runs when the model
 * invoked it; the owner's own keystrokes reach the handler unchanged.
 */
export function withCommandVerbs(command: SlashCommand, verbs: CommandVerbs): SlashCommand {
  assertCredentialArgsDeclared(command, verbs);
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

/**
 * A command with a verb that stores or presents a credential, or whose verb
 * effect depends on its arguments, must say which typed words are secret
 * (`secretArgs`, `{}` when none is typed): every executed line goes into the
 * input history, so an undeclared secret would be kept there in clear.
 */
function assertCredentialArgsDeclared(command: SlashCommand, verbs: CommandVerbs): void {
  if (command.secretArgs !== undefined) return;
  const mayTouchCredential = verbs.otherwise.effect === 'credential'
    || Object.values(verbs.verbs).some((entry) => typeof entry === 'function' || entry.effect === 'credential');
  if (mayTouchCredential) {
    throw new Error(`/${command.name} has a verb that stores or presents a credential; declare secretArgs on it ({} when no secret is typed on the line) so the input history never keeps one.`);
  }
}

/**
 * Declare the verbs of a command registered elsewhere (a shared terminal-shell
 * factory), without wrapping it. Only for commands with no owner-only verb:
 * the wrapper in withCommandVerbs is what refuses those.
 */
export function declareCommandVerbs(command: SlashCommand, verbs: CommandVerbs): void {
  if (Object.values(verbs.verbs).some((entry) => typeof entry !== 'function' && entry.ownerOnly) || verbs.otherwise.ownerOnly) {
    throw new Error(`/${command.name} declares an owner-only verb; register it with withCommandVerbs so the verb is refused for the model.`);
  }
  assertCredentialArgsDeclared(command, verbs);
  declarations.set(command, { name: command.name, verbs });
}

export const READ_VERB: CommandVerbPolicy = Object.freeze({ effect: 'read', ownerOnly: false });
export const LOCAL_WRITE_VERB: CommandVerbPolicy = Object.freeze({ effect: 'local-write', ownerOnly: false });
export const OUTWARD_VERB: CommandVerbPolicy = Object.freeze({ effect: 'outward', ownerOnly: false });
export const CREDENTIAL_VERB: CommandVerbPolicy = Object.freeze({ effect: 'credential', ownerOnly: false });

export function ownerOnlyVerb(effect: CommandVerbEffect, because: string, instead?: string): CommandVerbPolicy {
  return Object.freeze({ effect, ownerOnly: true, because, ...(instead === undefined ? {} : { instead }) });
}

/**
 * Shared commands whose verbs read state: the model runs those reads with no
 * admission, every other verb of theirs reaches the connected host.
 */
export const SHARED_COMMAND_VERBS: Readonly<Record<string, CommandVerbs>> = {
  'work-import': { defaultVerb: '', verbs: { preview: READ_VERB, status: READ_VERB }, otherwise: OUTWARD_VERB },
};

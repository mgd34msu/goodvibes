/** Platform command lookup, dispatch and exact one-dispatch terminal owner provenance. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SlashCommandRawRest } from './slash-command-parser.js';
import { captureNativeConversationInput, type NativeConversationInput } from './native/native-conversation-input.js';
import type { DaemonWriteRefusal } from '@goodvibes/engine/platform/platform/config';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { formatRefusal, readRefusal } from '@goodvibes/engine/errors';
import type { CommandDescription } from './command-actions/types.js';
import { Secret } from '@goodvibes/engine/platform/platform/security';

/**
 * The `afterCommand` both terminal apps give their registry: a setting a
 * command sent to the daemon shows at once, and each one the daemon then
 * refused is printed with its reason before the command counts as done. No
 * wait when the command sent nothing.
 */
export function reportDaemonWriteRefusals(context: {
  readonly print: (message: string) => void;
  readonly platform?: { readonly configManager?: { watchDaemonWrites?(): () => Promise<readonly DaemonWriteRefusal[]> } | undefined } | undefined;
}): (() => Promise<void>) | undefined {
  const finish = context.platform?.configManager?.watchDaemonWrites?.();
  if (!finish) return undefined;
  return async () => {
    for (const refusal of await finish()) {
      context.print(`Not saved: the daemon refused ${refusal.key} (${summarizeError(refusal.error)}); it is back at its previous value.`);
    }
  };
}
/**
 * Run a command picked from a list (the command palette, the /help list, a
 * view's button, a key that starts a command) and say what happened: an
 * unknown name and a refusal or failure are printed like a typed command's,
 * never left as an unhandled rejection. The returned promise always settles
 * normally. A caller that needs the error itself calls the registry directly.
 */
export async function runPickedCommand(
  run: ((name: string, args: string[]) => Promise<boolean>) | undefined,
  name: string,
  args: string[],
  report: (message: string) => void,
): Promise<void> {
  try {
    const handled = run ? await run(name, args) : false;
    if (!handled) report(`Unknown command: /${name}. Type /help for available commands.`);
  } catch (error) {
    const refused = readRefusal(error);
    report(refused ? formatRefusal(refused) : `Command /${name} failed: ${summarizeError(error)}`);
  }
}

export interface TerminalSlashCommand<Context> {
  name: string;
  aliases?: string[] | undefined;
  description: string;
  usage?: string | undefined;
  argsHint?: string | undefined;
  /**
   * False: left off the first screen (the bare `/` list, /help's list, the
   * palette's opening view); it is still found as soon as its name is typed and
   * still runs. Every command is reachable; this only orders the first screen.
   */
  firstScreen?: boolean | undefined;
  /** The one description a command built with `defineCommand` is generated from (command-actions/). */
  readonly described?: CommandDescription<Context> | undefined;
  /** Typed arguments that carry a secret; the input history stores `<redacted>` in their place. */
  secretArgs?: CommandSecretArgs | undefined;
  /**
   * The command's words are fields: besides the unclosed quote every command
   * refuses (slash-command-parser.ts), an empty quoted word is refused instead
   * of shifting the words after it into the wrong fields.
   */
  strictArgs?: boolean | undefined;
  /**
   * Free text: from this argument position on (or the position the function
   * returns for the arguments read so far) the handler receives the rest of
   * the typed line untouched, as one argument.
   */
  rawRest?: SlashCommandRawRest | undefined;
  /**
   * What running the command does, declared where the command is written: a
   * caller that is not the owner typing it (the Agent's model command runner)
   * reads it to decide which admission the run needs. `mixed` means its verbs
   * differ; `readVerbs` then names the first-argument verbs that only read.
   */
  effect?: TerminalCommandEffect | undefined;
  readVerbs?: readonly string[] | undefined;
  handler: (args: string[], context: Context) => void | Promise<void>;
}
export type TerminalCommandEffect = 'read-only' | 'local-state' | 'connected-host-state' | 'external-network'
  | 'ui-navigation' | 'session-lifecycle' | 'delegated-work' | 'mixed';
/**
 * Which typed arguments of a command are secrets. Positions count from the
 * first argument after the command name. `subcommands` keys on the first
 * argument, or the first two joined by a space (`set` in `/secrets set KEY
 * value`, `local add-user` in `/auth local add-user NAME PASSWORD`), and
 * counts positions the same way, so `{ subcommands: { set: [2] } }` is the
 * value. `flags` names options whose value is a secret, in either
 * `--flag value` or `--flag=value` form. `select` is for a command whose
 * secret depends on what the arguments name (a described command's secret
 * blank, wherever options put it): it returns the secret positions.
 * A command that declares `{}` states that it takes no typed secret.
 */
export interface CommandSecretArgs {
  readonly positions?: readonly number[] | undefined;
  /** Positions, or `{ from }` for every non-flag argument from that position on (a value that may contain spaces). */
  readonly subcommands?: Readonly<Record<string, readonly number[] | { readonly from: number }>> | undefined;
  readonly flags?: readonly string[] | undefined;
  readonly select?: ((args: readonly string[]) => Iterable<number>) | undefined;
}
const REDACTED_ARGUMENT = '<redacted>';
/** The word that ends options: every argument after it is a value, never a flag. */
const END_OF_OPTIONS = '--';
function quoteHistoryArgument(value: string): string {
  return /\s/.test(value) || value === '' ? JSON.stringify(value) : value;
}

/** Where a command's secret arguments sit in one typed line: whole arguments, and `--flag=value` arguments whose value part is secret. */
export interface SecretArgPositions {
  /** Arguments that are entirely a secret. */
  readonly whole: ReadonlySet<number>;
  /** `--flag=value` arguments whose part after `=` is a secret. */
  readonly inline: ReadonlySet<number>;
}

/**
 * The positions of the secrets in `args` under a command's declaration: the
 * one reading both the history line and the handler's `secretArg` use, so the
 * mask and the read cannot drift. After a bare `--` every argument is a value:
 * a value that starts with `--` is still a secret, and is never taken for a
 * flag.
 */
export function secretArgPositions(args: readonly string[], secretArgs: CommandSecretArgs | undefined): SecretArgPositions {
  const whole = new Set<number>();
  const inline = new Set<number>();
  if (!secretArgs) return { whole, inline };
  const optionsEnd = args.indexOf(END_OF_OPTIONS);
  const isFlag = (index: number): boolean => (optionsEnd === -1 || index < optionsEnd) && args[index]!.startsWith('--');
  for (const position of secretArgs.positions ?? []) whole.add(position);
  const first = args[0]?.toLowerCase();
  const second = args[1]?.toLowerCase();
  for (const key of [first, first !== undefined && second !== undefined ? `${first} ${second}` : undefined]) {
    if (key === undefined || !secretArgs.subcommands || !Object.hasOwn(secretArgs.subcommands, key)) continue;
    const declared = secretArgs.subcommands[key]!;
    if ('from' in declared) {
      // The values from that position on, counted as written or among the values alone
      // (options and the bare `--` are not values), whichever masks more.
      let seen = 0;
      for (let index = 1; index < args.length; index++) {
        if (index === optionsEnd || isFlag(index)) continue;
        seen += 1;
        if (seen >= declared.from || index >= declared.from) whole.add(index);
      }
    } else for (const position of declared) whole.add(position);
  }
  for (const position of secretArgs.select?.(args) ?? []) whole.add(position);
  const flags = new Set(secretArgs.flags ?? []);
  for (let index = 0; index < args.length; index++) {
    if (!isFlag(index)) continue;
    const value = args[index]!;
    const equals = value.indexOf('=');
    if (equals > 0 && flags.has(value.slice(0, equals))) inline.add(index);
    else if (flags.has(value) && index + 1 < args.length) whole.add(index + 1);
  }
  whole.delete(optionsEnd);
  return { whole, inline };
}

/**
 * The line the input history keeps for an executed command: the typed line as
 * it was, or, when the command declares secret arguments and the line has
 * them, the command rebuilt with `<redacted>` in each secret's place.
 */
export function commandHistoryLine(
  rawLine: string,
  name: string,
  args: readonly string[],
  secretArgs: CommandSecretArgs | undefined,
): string {
  if (!secretArgs) return rawLine.trim();
  const { whole, inline } = secretArgPositions(args, secretArgs);
  if (whole.size === 0 && inline.size === 0) return rawLine.trim();
  const kept = args.map((value, index) => {
    if (whole.has(index)) return REDACTED_ARGUMENT;
    if (inline.has(index)) return `${value.slice(0, value.indexOf('='))}=${REDACTED_ARGUMENT}`;
    return quoteHistoryArgument(value);
  });
  return [`/${name}`, ...kept].join(' ');
}

/** A handler asked for an argument its command did not declare secret: the declaration and the read must agree. */
export class UndeclaredSecretArgumentError extends Error {
  readonly code = 'UNDECLARED_SECRET_ARGUMENT';
  constructor(readonly command: string, readonly index: number) {
    super(`/${command} read argument ${index} as a secret, but its registration does not declare that position in secretArgs; nothing was done. Declare it so the input history masks it too.`);
    this.name = 'UndeclaredSecretArgumentError';
  }
}

/** The command being run in this dispatch, for `secretArg`. */
interface CommandDispatch {
  readonly name: string;
  readonly args: readonly string[];
  readonly secrets: SecretArgPositions;
}

// Nested dispatch cannot mint a keyboard gesture, including across product registries.
const commandDispatchScope = new AsyncLocalStorage<CommandDispatch>();

/**
 * A secret argument of the command running now, as a `Secret` (its text
 * leaves only through `reveal`). The position must be one the command's
 * `secretArgs` declares for these arguments, so whatever a handler reads as a
 * secret is also what the input history masked; anything else throws
 * `UndeclaredSecretArgumentError`. For a `--flag=value` argument the value
 * part is returned.
 */
export function secretArg(index: number): Secret {
  const dispatch = commandDispatchScope.getStore();
  if (!dispatch) throw new Error('secretArg is read only while a command handler runs.');
  const value = dispatch.args[index];
  if (value === undefined || !(dispatch.secrets.whole.has(index) || dispatch.secrets.inline.has(index))) {
    throw new UndeclaredSecretArgumentError(dispatch.name, index);
  }
  return Secret.of(dispatch.secrets.inline.has(index) ? value.slice(value.indexOf('=') + 1) : value, `/${dispatch.name} argument ${index}`);
}

/**
 * Words typed after `/` that run another command but are not commands: no
 * entry in any list, the picker, completion, /help or the reference. Looked up
 * only when no registered command or alias has the word.
 */
const ACCEPTED_COMMAND_WORDS: Readonly<Record<string, string>> = { exit: 'quit' };
/** True for a word in that table; a command or alias of the same name still wins over it. */
export function isAcceptedCommandWord(word: string): boolean {
  return Object.hasOwn(ACCEPTED_COMMAND_WORDS, word);
}

export interface TerminalCommandRegistry<Context> {
  register(command: TerminalSlashCommand<Context>): void;
  unregister(name: string): void;
  get(name: string): TerminalSlashCommand<Context> | undefined;
  getAll(): TerminalSlashCommand<Context>[];
  getVisible(): TerminalSlashCommand<Context>[];
  list(): TerminalSlashCommand<Context>[];
  fuzzyMatch(query: string): Array<{ command: TerminalSlashCommand<Context>; score: number }>;
  execute(name: string, args: string[], context: Context): Promise<boolean>;
  executeFromOwner(name: string, args: string[], context: Context, rawInput?: string): Promise<boolean>;
}
export interface TerminalCommandRegistryFactory<Context> {
  readonly CommandRegistry: new () => TerminalCommandRegistry<Context>;
  readonly isDirectOwnerCommandContext: (context: Context, commandName?: string) => boolean;
  readonly directOwnerWorkstreamInput: (context: Context) => NativeConversationInput | undefined;
  readonly directOwnerRemoteInput: (context: Context) => string | undefined;
  readonly directOwnerPlanningInput: (context: Context) => NativeConversationInput | undefined;
}
export function createTerminalCommandRegistry<
  Context extends {
    readonly invokedByModel?: boolean | undefined;
  },
>(
  options: {
    readonly commonNames?: ReadonlySet<string> | undefined;
    /**
     * Called as an outermost command starts; the function it returns runs once
     * the handler has finished (or thrown), so what a command started but could
     * not wait for (a setting the daemon has not answered on) is reported
     * before the command counts as done. Nested dispatch is covered by the
     * outermost one.
     */
    readonly afterCommand?: ((context: Context) => (() => Promise<void>) | undefined) | undefined;
  } = {},
): TerminalCommandRegistryFactory<Context> {
  const commonNames = new Set(options.commonNames ?? []);
  const directOwnerCommands = new WeakMap<
    Context,
    {
      readonly name: string;
      readonly rawInput?: string | undefined;
    }
  >();
  function isDirectOwnerCommandContext(context: Context, commandName?: string | undefined): boolean {
    return (
      context.invokedByModel !== true &&
      directOwnerCommands.has(context) &&
      (commandName === undefined || directOwnerCommands.get(context)?.name === commandName)
    );
  }
  /** The terminal's exact request span, never reconstructed from tokenized arguments.
   * One whitespace separator after `start` belongs to command syntax (CRLF is one
   * separator). All following bytes, including extra leading/trailing whitespace,
   * are owner source. Command-leading whitespace is syntax, not request text.
   */
  function directOwnerWorkstreamInput(context: Context): NativeConversationInput | undefined {
    if (!isDirectOwnerCommandContext(context, 'workstream')) return undefined;
    const raw = directOwnerCommands.get(context)?.rawInput;
    const match = raw?.match(/^\s*\/workstream\s+start(?:(?:\r\n|\s)([\s\S]*))?$/);
    return match ? captureNativeConversationInput(match[1] ?? '') : undefined;
  }
  /** Exact terminal-authored remote dispatch, retained before the handler returns.
   * Generated delegation text and model-invoked slash commands cannot become authority.
   */
  function directOwnerRemoteInput(context: Context): string | undefined {
    if (!isDirectOwnerCommandContext(context, 'remote')) return undefined;
    const raw = directOwnerCommands.get(context)?.rawInput;
    return raw && /^\s*\/remote\s+dispatch(?:-pool)?\s/.test(raw) ? raw : undefined;
  }
  /** A work request (`/work request <goal>`) shares the terminal-only capture boundary with workstream starts.
   * Exactly one separator after `request` is syntax; the remaining source is retained verbatim.
   */
  function directOwnerPlanningInput(context: Context): NativeConversationInput | undefined {
    if (!isDirectOwnerCommandContext(context, 'work')) return undefined;
    const raw = directOwnerCommands.get(context)?.rawInput;
    const match = raw?.match(/^\s*\/work\s+request(?:(?:\r\n|\s)([\s\S]*))?$/);
    return match ? captureNativeConversationInput(match[1] ?? '') : undefined;
  }
  class CommandRegistry {
    private commands = new Map<string, TerminalSlashCommand<Context>>();
    private aliasIndex = new Map<string, TerminalSlashCommand<Context>>();
    /**
     * Register a command. Also indexes all aliases for O(1) lookup.
     * Throws if the primary name or any alias collides with an existing
     * registration, silent last-write-wins previously shadowed whole
     * commands, so collisions must fail fast at startup (and are caught
     * statically by the alias lint test).
     */
    register(command: TerminalSlashCommand<Context>): void {
      // Every registered command is rendered with its description in /help, the
      // command palette, and the generated reference (docs/commands-reference.md).
      // A blank description would ship an unexplained row in all three, so it
      // fails fast here, the release gate red-tests this invariant.
      if (!command.description || command.description.trim().length === 0) {
        throw new Error(`Command registration for "${command.name}" has no description: every command must describe itself.`);
      }
      const existingByName = this.commands.get(command.name) ?? this.aliasIndex.get(command.name);
      if (existingByName) {
        throw new Error(`Command registration collision: "${command.name}" is already registered by /${existingByName.name}.`);
      }
      for (const alias of command.aliases ?? []) {
        const holder = this.commands.get(alias) ?? this.aliasIndex.get(alias);
        if (holder) {
          throw new Error(`Command alias collision: "${alias}" on /${command.name} is already registered by /${holder.name}.`);
        }
      }
      this.commands.set(command.name, command);
      for (const alias of command.aliases ?? []) {
        this.aliasIndex.set(alias, command);
      }
    }
    /** Remove a command by primary name. Also removes its alias entries. */
    unregister(name: string): void {
      const cmd = this.commands.get(name);
      if (cmd) {
        for (const alias of cmd.aliases ?? []) {
          this.aliasIndex.delete(alias);
        }
      }
      this.commands.delete(name);
    }
    /**
     * get - Look up a command by its primary name or any alias. O(1) for both.
     */
    get(name: string): TerminalSlashCommand<Context> | undefined {
      const found = this.commands.get(name) ?? this.aliasIndex.get(name);
      if (found || !isAcceptedCommandWord(name)) return found;
      return this.commands.get(ACCEPTED_COMMAND_WORDS[name]!);
    }
    /** The commands on the first screen. */
    getVisible(): TerminalSlashCommand<Context>[] {
      return this.getAll().filter((command) => command.firstScreen !== false);
    }
    /** All registered commands. */
    getAll(): TerminalSlashCommand<Context>[] {
      return Array.from(this.commands.values());
    }
    /**
     * list - Compatibility alias for the simpler platform registry surface.
     */
    list(): TerminalSlashCommand<Context>[] {
      return this.getAll();
    }
    /**
     * fuzzyMatch - Return commands ranked by how well `query` matches their
     * name or aliases. Returns all commands when query is empty.
     */
    fuzzyMatch(query: string): Array<{
      command: TerminalSlashCommand<Context>;
      score: number;
    }> {
      const q = query.toLowerCase();
      const results: Array<{
        command: TerminalSlashCommand<Context>;
        score: number;
      }> = [];
      for (const cmd of this.commands.values()) {
        const names = [cmd.name, ...(cmd.aliases ?? [])];
        let bestScore = 0;
        for (const candidate of names) {
          const score = scoreMatch(q, candidate);
          if (score > bestScore) bestScore = score;
        }
        // Off the first screen means only that: an empty query leaves it out, any typed text finds it.
        if (cmd.firstScreen === false && q === '') continue;
        if (bestScore > 0 || q === '') {
          // with no query yet, rank the curated common tier (score 2)
          // ahead of everything else (score 1), the tie-break below then sorts
          // each tier alphabetically, so the result is "common tier, then the
          // alphabetical rest" rather than one flat alphabetical list.
          const score = q === '' ? (commonNames.has(cmd.name) ? 2 : 1) : bestScore;
          results.push({ command: cmd, score });
        }
      }
      // Sort: higher score first, then alphabetically
      results.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
      return results;
    }
    /**
     * execute - Look up and run a command. Resolves true when it ran and false
     * when no command has that name. A command that refuses throws its refusal
     * (`RefusalError`, with the state, reason and next step), so the promise
     * rejects with it: a caller reports "Failed: <reason>", never "Done".
     */
    async execute(rawName: string, args: string[], context: Context): Promise<boolean> {
      const cmd = this.get(rawName);
      if (!cmd) return false;
      const after = commandDispatchScope.getStore() ? undefined : options.afterCommand?.(context);
      try {
        await commandDispatchScope.run(dispatchOf(cmd, args), () => cmd.handler(args, directOwnerCommands.has(context) ? { ...context } : context));
      } finally {
        if (after) await after().catch(() => { /* reporting cannot change the command's outcome */ });
      }
      return true;
    }
    /** Reserved for the terminal's direct key-input route, not tools or startup. */
    async executeFromOwner(rawName: string, args: string[], context: Context, rawInput?: string | undefined): Promise<boolean> {
      const cmd = this.get(rawName);
      if (!cmd) return false;
      const owned = { ...context };
      if (context.invokedByModel !== true && !commandDispatchScope.getStore() && !directOwnerCommands.has(context)) {
        directOwnerCommands.set(owned, { name: cmd.name, rawInput });
      }
      const after = commandDispatchScope.getStore() ? undefined : options.afterCommand?.(context);
      try {
        await commandDispatchScope.run(dispatchOf(cmd, args), () => cmd.handler(args, owned));
        return true;
      } finally {
        directOwnerCommands.delete(owned);
        if (after) await after().catch(() => { /* reporting cannot change the command's outcome */ });
      }
    }
  }
  return { CommandRegistry, isDirectOwnerCommandContext, directOwnerWorkstreamInput, directOwnerPlanningInput, directOwnerRemoteInput };
}
function dispatchOf(command: { readonly name: string; readonly secretArgs?: CommandSecretArgs | undefined }, args: readonly string[]): CommandDispatch {
  return { name: command.name, args: [...args], secrets: secretArgPositions(args, command.secretArgs) };
}
function scoreMatch(query: string, candidate: string): number {
  if (query === '') return 1;
  if (candidate === query) return 100;
  if (candidate.startsWith(query)) return 80;
  // Subsequence check
  let qi = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] === query[qi]) qi++;
  }
  if (qi === query.length) return 40 - query.length; // shorter query → higher score
  return 0;
}

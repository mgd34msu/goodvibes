/** Platform command lookup, dispatch and exact one-dispatch terminal owner provenance. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { captureNativeConversationInput, type NativeConversationInput } from './native/native-conversation-input.js';
export interface TerminalSlashCommand<Context> {
  name: string;
  aliases?: string[] | undefined;
  description: string;
  usage?: string | undefined;
  argsHint?: string | undefined;
  hidden?: boolean | undefined;
  handler: (args: string[], context: Context) => void | Promise<void>;
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
// Nested dispatch cannot mint a keyboard gesture, including across product registries.
const commandDispatchScope = new AsyncLocalStorage<boolean>();
export function createTerminalCommandRegistry<
  Context extends {
    readonly invokedByModel?: boolean | undefined;
  },
>(
  options: {
    readonly commonNames?: ReadonlySet<string> | undefined;
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
  /** New planning goals share the terminal-only capture boundary with workstream starts.
   * Exactly one separator is syntax; the remaining source is retained verbatim.
   * Aliases resolve to project-plan in the private dispatch mark, never in source.
   */
  function directOwnerPlanningInput(context: Context): NativeConversationInput | undefined {
    if (!isDirectOwnerCommandContext(context, 'project-plan')) return undefined;
    const raw = directOwnerCommands.get(context)?.rawInput;
    const match = raw?.match(/^\s*\/(?:project-plan|planning)(?:(?:\r\n|\s)([\s\S]*))?$/);
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
      return this.commands.get(name) ?? this.aliasIndex.get(name);
    }
    getVisible(): TerminalSlashCommand<Context>[] {
      return this.getAll().filter((command) => !command.hidden);
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
        if (cmd.hidden && !names.some((name) => name.toLowerCase() === q)) continue;
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
     * execute - Look up and run a command. Returns true if found, false otherwise.
     */
    async execute(rawName: string, args: string[], context: Context): Promise<boolean> {
      const cmd = this.get(rawName);
      if (!cmd) return false;
      await commandDispatchScope.run(true, () => cmd.handler(args, directOwnerCommands.has(context) ? { ...context } : context));
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
      try {
        await commandDispatchScope.run(true, () => cmd.handler(args, owned));
        return true;
      } finally {
        directOwnerCommands.delete(owned);
      }
    }
  }
  return { CommandRegistry, isDirectOwnerCommandContext, directOwnerWorkstreamInput, directOwnerPlanningInput, directOwnerRemoteInput };
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

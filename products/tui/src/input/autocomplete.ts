import { AutocompleteEngine as PlatformAutocomplete, type AutocompleteResult as Match, type AutocompleteState as State } from '@goodvibes-jev/engine/terminal-shell/autocomplete';
import { COMMON_COMMAND_NAMES, type SlashCommand, type CommandRegistry } from './command-registry.ts';
export type AutocompleteResult = Match<SlashCommand>;
export type AutocompleteState = State<SlashCommand>;
export class AutocompleteEngine extends PlatformAutocomplete<SlashCommand> {
  constructor(registry: CommandRegistry) { super(registry, COMMON_COMMAND_NAMES); }
}

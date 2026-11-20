import { AutocompleteEngine as PlatformAutocomplete, type AutocompleteListSource, type AutocompleteResult as Match, type AutocompleteState as State } from '@goodvibes/engine/terminal-shell/autocomplete';
import type { SlashCommand, CommandRegistry } from './command-registry.ts';
export type AutocompleteResult = Match<SlashCommand>;
export type AutocompleteState = State<SlashCommand>;
export class AutocompleteEngine extends PlatformAutocomplete<SlashCommand> {
  constructor(registry: CommandRegistry, lists?: AutocompleteListSource) { super(registry, new Set(), lists); }
}

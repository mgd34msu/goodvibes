import { renderAutocompleteOverlay as paint } from '@goodvibes-jev/engine/terminal-shell/autocomplete-overlay';
import type { AutocompleteEngine } from '../input/autocomplete.ts';
export * from '@goodvibes-jev/engine/terminal-shell/autocomplete-overlay';
export const renderAutocompleteOverlay = (autocomplete: AutocompleteEngine, width: number, height = 24) => paint(autocomplete, width, height, true);

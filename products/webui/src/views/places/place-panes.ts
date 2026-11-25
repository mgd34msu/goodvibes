/**
 * The web twins of the custom panes a place's list names (`pane: '<name>'` on
 * the list, for a detail that is more than label and value lines, such as a
 * work's step graph), by the same name. A list that names a pane with no twin
 * here shows its item's plain detail lines instead.
 *
 * No declaration names a pane yet, so there is no twin yet.
 */
import type { ComponentType } from 'react';
import type { PlaceItem } from '../../lib/places';

export const PLACE_PANES: Readonly<Record<string, ComponentType<{ readonly item: PlaceItem }>>> = {};

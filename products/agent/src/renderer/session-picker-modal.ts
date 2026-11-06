/**
 * renderSessionPickerModal, the /sessions picker drawn with the modal surface kit.
 *
 * Saved sessions grouped by recency (today, yesterday, this week, earlier)
 * with message count and age right-aligned and muted, and an always-live
 * search row. Deleting is an explicit slash command in the agent, so `d`
 * only shows that command as a status line under the list.
 */

import './theme.ts';
import type { SessionPickerModal } from '../input/session-picker-modal.ts';
import { renderSessionPickerStatePackageText } from '../input/session-picker-modal.ts';
import './modal-utils.ts';
import './surface-kit.ts';
import './surface-kit-list.ts';

/** Short age for the right column: HH:MM today, "Mon D" this year, the full date otherwise. */

/** The static strings this surface can show (checked by package verification). */
export function renderSessionPickerPackageText(): string {
  return [
    'Sessions',
    'Search sessions',
    '<n> saved',
    '<n> of <total>',
    'Today',
    'Yesterday',
    'This week',
    'Earlier',
    'No saved sessions.',
    'Open Agent Workspace -> Conversation -> Save current session.',
    'No sessions match "<query>".',
    '<n> msgs',
    'move',
    'load',
    'how to delete',
    'edit search',
    renderSessionPickerStatePackageText(),
  ].join('\n');
}

/**
 * Render the session picker as a modal layer.
 *
 * @param modal         SessionPickerModal state.
 * @param screenWidth   Terminal width.
 * @param screenHeight  Terminal height.
 * @param now           Clock for the recency groups (tests pass a fixed value).
 */

import { createSessionPickerRenderer } from '@goodvibes-jev/engine/terminal-shell/renderer/session-picker';
export const { renderSessionPickerModal } = createSessionPickerRenderer<SessionPickerModal>({
  allowDelete: false,
  mouseNavigation: false,
  openLabel: 'load',
  deleteLabel: 'how to delete',
  saveHint: 'Open Agent Workspace -> Conversation -> Save current session.',
});

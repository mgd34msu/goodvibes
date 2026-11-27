import { createSessionPickerRenderer } from '@goodvibes/engine/terminal-shell/renderer/session-picker';
/**
 * renderSessionPickerModal, the /sessions picker drawn with the modal surface kit.
 *
 * Saved sessions grouped by recency (today, yesterday, this week, earlier)
 * with message count and age right-aligned and muted, and an always-live
 * search row. Deleting is an explicit slash command in the agent, so Ctrl+D
 * only shows that command as a status line under the list.
 */

import type { SessionPickerModal } from '../input/session-picker-modal.ts';
import { renderSessionPickerStatePackageText } from '../input/session-picker-modal.ts';

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
    'Save this one from This conversation, in the menu (Ctrl+G then m).',
    'No sessions match "<query>".',
    '<n> msgs',
    'move',
    'load',
    'how to delete',
    'edit search',
    renderSessionPickerStatePackageText(),
  ].join('\n');
}

/** The session picker as a modal layer: (modal, screenWidth, screenHeight, now?). */
export const { renderSessionPickerModal } = createSessionPickerRenderer<SessionPickerModal>({
  allowDelete: false,
  mouseNavigation: false,
  openLabel: 'load',
  deleteLabel: 'how to delete',
  saveHint: 'Save the current session from This conversation, in the menu.',
});

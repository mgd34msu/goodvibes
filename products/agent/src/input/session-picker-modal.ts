import { SavedSessionPickerState } from '@goodvibes/engine/terminal-shell/session-picker-state';
/**
 * SessionPickerModal, state management for the /sessions picker modal.
 *
 * Lists sessions from SessionManager.list(), tracks selected index,
 * and handles load actions.
 */

import type { SessionInfo, SessionManager } from '@goodvibes/engine/platform/platform/sessions';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { CommandContext } from './command-registry.ts';
import { loadSavedSessionIntoLive } from './commands/session-load.ts';

function sessionLoadedMessage(name: string, messageCount: number): string {
  return `Loaded session ${name} (${messageCount} messages)`;
}

function sessionDeletionCommandRequiredMessage(name: string): string {
  return `Session ${name} is deleted in the Sessions place: select it there and press its delete key.`;
}

export function renderSessionPickerStatePackageText(): string {
  return [
    'Loaded session <session> (<count> messages)',
    'Error',
    'Session <session> is deleted in the Sessions place: select it there and press its delete key.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// SessionPickerModal
// ---------------------------------------------------------------------------

export class SessionPickerModal extends SavedSessionPickerState {
  /** Last status message to show in the modal (e.g. error or success). */

  /**
   * The always-live search query. Filters the sessions by name and title;
   * selectedIndex and scrollOffset index the filtered list.
   */

  /**
   * Open the modal, loading sessions from SessionManager.
   */

  /** The sessions matching the query (all of them when it is empty). */

  /** Replace the query; the selection returns to the first match. */

  /**
   * Load the currently selected session into the live conversation through the
   * one resume routine `/load` and `/session resume` use: it refuses while a
   * turn runs, reads the saved messages before touching the live conversation,
   * puts back turns that exist only in the journal, re-resolves the saved model
   * and moves the session identity. Resolves true on success, false on error or
   * refusal; the live conversation is untouched in that case.
   */
  async loadSelected(context: CommandContext): Promise<boolean> {
    const session = this.getSelected();
    if (!session) return false;

    try {
      const loaded = await loadSavedSessionIntoLive(context, this.sessionManager, session.name);
      // What the load left out (a damaged side branch) is said now, before the next save drops it.
      this.statusMessage = [sessionLoadedMessage(session.name, loaded.messageCount), ...loaded.notices].join(' ');
      for (const line of loaded.notices) context.print(line);
      return true;
    } catch (e) {
      this.statusMessage = `Error ${summarizeError(e)}`;
      return false;
    }
  }

  deleteSelected(): boolean {
    const session = this.getSelected();
    if (!session) return false;
    this.deleteConfirmationTarget = null;
    this.statusMessage = sessionDeletionCommandRequiredMessage(session.name);
    return false;
  }
}

import { restoreConversationContent } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
import { SavedSessionPickerState } from '@goodvibes-jev/engine/terminal-shell/session-picker-state';
/**
 * SessionPickerModal, state management for the /sessions picker modal.
 *
 * Lists sessions from SessionManager.list(), tracks selected index,
 * and handles load actions.
 */

import type { SessionInfo, SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { ConversationManager } from '../core/conversation';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { readConversationMessageSnapshots } from '../core/conversation-message-snapshot.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { CommandContext } from './command-registry.ts';
import { loadSavedSessionIntoLive } from './commands/session-load.ts';

function sessionLoadedMessage(name: string, messageCount: number): string {
  return `Loaded session ${name} (${messageCount} messages)`;
}

function sessionDeletionCommandRequiredMessage(name: string): string {
  return `Deletion requires an explicit command: /session delete ${quoteSlashCommandArg(name)} --yes`;
}

export function renderSessionPickerStatePackageText(): string {
  return [
    'Loaded session <session> (<count> messages)',
    'Error',
    'Deletion requires an explicit command: /session delete <session> --yes',
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
   * Load the currently selected session into the live conversation.
   * Returns true on success, false on error or refusal; the live conversation is
   * untouched in that case. With a command context the load switches the session
   * identity like `/session resume` and refuses while a turn runs; without one only
   * the conversation content is replaced.
   */
  loadSelected(conversationManager: ConversationManager, context?: CommandContext): boolean {
    const session = this.getSelected();
    if (!session) return false;

    try {
      if (context) {
        const loaded = loadSavedSessionIntoLive(context, this.sessionManager, session.name);
        this.statusMessage = sessionLoadedMessage(session.name, loaded.messageCount);
        return true;
      }
      const { meta, messages, branches } = this.sessionManager.load(session.name);
      // Read the saved messages before the live conversation is cleared so an invalid one leaves it intact.
      const snapshots = readConversationMessageSnapshots(messages);
      restoreConversationContent(conversationManager, snapshots as never[], meta.title, branches);
      this.statusMessage = sessionLoadedMessage(session.name, messages.length);
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

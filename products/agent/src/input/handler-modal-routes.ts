import { sessionPickerDeleteNamedKey } from '@goodvibes/engine/terminal-shell/searchable-modal-route';
import { createSearchableModalTokenRoute } from '@goodvibes/engine/terminal-shell/searchable-modal-route';
// The settings screen is the one both programs show (terminal-shell settings-screen), a kit modal that reads its own keys.
export { handleSelectionModalToken, handleBookmarkModalToken } from '@goodvibes/engine/terminal-shell/modal-input-routes';

import type { CommandContext } from './command-registry.ts';

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    loadSelected: (context: CommandContext) => Promise<unknown>;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
    query: string;
    setQuery: (query: string) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export const handleSessionPickerToken = createSearchableModalTokenRoute<SessionPickerRouteState>({
  modal: (state) => state.sessionPickerModal,
  enter(state) {
    // The load re-resolves the saved model, so its status line arrives after this key returns.
    if (state.commandContext) void state.sessionPickerModal.loadSelected(state.commandContext).then(() => state.requestRender());
  },

  namedKey: sessionPickerDeleteNamedKey,
});

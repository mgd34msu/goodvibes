import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import { isTextBackspace } from './delete-key-policy.js';
interface SearchableModal {
  readonly active: boolean;
  readonly query: string;
  setQuery(query: string): void;
  moveUp(): void;
  moveDown(): void;
}
interface ModalRouteState {
  requestRender(): void;
  handleEscape(): void;
}
/**
 * Search and navigation are shared; resume/save/delete admission stays with the
 * owning product. Every printable character is typed into the query: actions
 * come only from named keys and Ctrl chords (`namedKey`), so a search that
 * starts with any letter never fires one.
 */
export function createSearchableModalTokenRoute<State extends ModalRouteState>(policy: {
  readonly modal: (state: State) => SearchableModal;
  readonly enter: (state: State) => void;
  readonly cancelConfirmation?: ((state: State) => boolean) | undefined;
  readonly namedKey: (state: State, key: string, ctrl: boolean) => void;
  readonly editEmptyQuery?: boolean | undefined;
}) {
  return function handleSearchableModalToken(state: State, token: InputToken): boolean {
    const modal = policy.modal(state);
    if (!modal.active) return false;
    if (token.type === 'key') {
      if (token.logicalName === 'escape') {
        if (policy.cancelConfirmation?.(state)) state.requestRender();
        else state.handleEscape();
        return true;
      }
      if (token.logicalName === 'enter') policy.enter(state);
      else if (token.logicalName === 'up') modal.moveUp();
      else if (token.logicalName === 'down') modal.moveDown();
      else if (isTextBackspace(token.logicalName ?? '')) {
        if (policy.editEmptyQuery !== false || modal.query.length > 0) modal.setQuery(modal.query.slice(0, -1));
      } else if (token.logicalName) policy.namedKey(state, token.logicalName, token.ctrl === true);
    } else if (token.type === 'text') {
      modal.setQuery(modal.query + token.value);
    }
    state.requestRender();
    return true;
  };
}

interface SessionPickerDeleteState {
  readonly sessionPickerModal: { deleteSelected(): void };
}
/** Ctrl+D arms (then confirms) deleting the selected session; a bare d is search text. */
export function sessionPickerDeleteNamedKey(state: SessionPickerDeleteState, key: string, ctrl: boolean): void {
  if (key === 'd' && ctrl) state.sessionPickerModal.deleteSelected();
}

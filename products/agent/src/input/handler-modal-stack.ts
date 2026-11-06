export * from '@goodvibes-jev/engine/terminal-shell/modal-stack';
import { handleEscape as escape, type EscapeState } from '@goodvibes-jev/engine/terminal-shell/modal-stack';
export const handleEscape = (state: EscapeState) => escape(state, true);

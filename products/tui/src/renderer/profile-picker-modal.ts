import { createProfilePickerRenderer } from '@goodvibes-jev/engine/terminal-shell/renderer/profile-picker-modal';
export const { renderProfilePickerModal } = createProfilePickerRenderer({
 hints: [['↑↓','move'],['⏎','load'],['ctrl+d','delete'],['ctrl+s','save current']], canDelete:true,
 emptyHint:'Press Ctrl+S to save the current settings as a profile.', trackVisibleRows:false, mouseNavigation:true,
});

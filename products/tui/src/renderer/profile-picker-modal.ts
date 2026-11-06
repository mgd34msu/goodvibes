import { createProfilePickerRenderer } from '@goodvibes-jev/engine/terminal-shell/renderer/profile-picker-modal';
export const { renderProfilePickerModal } = createProfilePickerRenderer({
 hints: [['↑↓','move'],['⏎','load'],['d','delete'],['s','save current']], canDelete:true,
 emptyHint:'Press s to save the current settings as a profile.', trackVisibleRows:false, mouseNavigation:true,
});

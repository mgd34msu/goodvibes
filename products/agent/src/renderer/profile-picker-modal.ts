import { createProfilePickerRenderer } from '@goodvibes/engine/terminal-shell/renderer/profile-picker-modal';
import { renderProfilePickerStatePackageText } from '../input/profile-picker-modal.ts';
const renderer = createProfilePickerRenderer({
 hints:[['↑↓','move'],['⏎','load']],canDelete:false,
 emptyHint:'Separate Agent homes are made and managed on the Agent homes tab of Memory and knowledge, in the menu (Ctrl+G then m).',
 description:'display, provider, behavior',note:'Agent profiles: Memory and knowledge, in the menu', trackVisibleRows:true,mouseNavigation:false,
});
export const renderProfilePickerModal = renderer.renderProfilePickerModal;
export function renderProfilePickerPackageText(): string { return renderer.renderProfilePickerPackageText(renderProfilePickerStatePackageText()); }

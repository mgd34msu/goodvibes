import { createProfilePickerRenderer } from '@goodvibes-jev/engine/terminal-shell/renderer/profile-picker-modal';
import { renderProfilePickerStatePackageText } from '../input/profile-picker-modal.ts';
const renderer = createProfilePickerRenderer({
 hints:[['↑↓','move'],['⏎','load']],canDelete:false,
 emptyHint:'Open Agent Workspace -> Profiles to create and manage isolated Agent profile homes.',
 description:'display, provider, behavior',note:'Agent profiles: /agent profiles', trackVisibleRows:true,mouseNavigation:false,
});
export const renderProfilePickerModal = renderer.renderProfilePickerModal;
export function renderProfilePickerPackageText(): string { return renderer.renderProfilePickerPackageText(renderProfilePickerStatePackageText()); }

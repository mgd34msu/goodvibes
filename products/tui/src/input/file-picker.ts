import { FilePickerModal as PlatformFilePickerModal, type FilePickerWorkspace } from '@goodvibes-jev/engine/terminal-shell/file-picker';
export class FilePickerModal extends PlatformFilePickerModal {
  constructor(workspace: FilePickerWorkspace) { super(workspace, 'tui.file-picker.skip-directory'); }
}

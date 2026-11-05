import { FilePickerModal as PlatformFilePickerModal, type FilePickerWorkspace } from '@goodvibes-jev/engine/terminal-shell/file-picker';
export class FilePickerModal extends PlatformFilePickerModal {
  constructor(workspace: FilePickerWorkspace) { super(workspace, 'agent.file-picker.skip-directory'); }
}

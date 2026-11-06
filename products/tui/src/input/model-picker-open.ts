import { openModelPickerNow as open, type ModelPickerOpenDeps as PlatformDeps } from '@goodvibes-jev/engine/terminal-shell/model-picker-open';
import type { ModelPickerModal, ModelPickerTargetInfo } from './model-picker.ts';
export interface ModelPickerOpenDeps extends PlatformDeps<ModelPickerTargetInfo> { readonly picker: ModelPickerModal }
export const openModelPickerNow = (deps: ModelPickerOpenDeps, mode: 'models' | 'providers' = 'models') => open(deps, mode);

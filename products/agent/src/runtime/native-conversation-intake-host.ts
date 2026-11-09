import { createNativeConversationIntakeBinding as bind } from '@goodvibes-jev/engine/terminal-shell/native-intake-host';
import type { NativeSubmissionHost } from './native-work-submission-host.ts';
import type { GatePresetName } from '@goodvibes-jev/engine/platform/platform/gate/presets';
export const createNativeConversationIntakeBinding = (host: NativeSubmissionHost, projectId: string, current: () => boolean = () => true, readMode?: () => GatePresetName) => bind(host, projectId, current, { allowHosted: true, ...(readMode ? { readMode } : {}) });

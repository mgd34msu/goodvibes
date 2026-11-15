import { NativeConversationIntakeJournal as PlatformJournal, type NativeIntakeJournalIO } from '@goodvibes-jev/engine/terminal-shell/native-intake-journal';
import { TUI_NATIVE_INTAKE_POLICY } from '@goodvibes-jev/engine/terminal-shell/native-intake';
export * from '@goodvibes-jev/engine/terminal-shell/native-intake-journal';
export class NativeConversationIntakeJournal extends PlatformJournal {
  constructor(path: string, io: Partial<NativeIntakeJournalIO> = {}) { super(path, io, TUI_NATIVE_INTAKE_POLICY); }
}

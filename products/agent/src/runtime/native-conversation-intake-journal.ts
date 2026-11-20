import { NativeConversationIntakeJournal as PlatformJournal, type NativeIntakeJournalIO } from '@goodvibes/engine/terminal-shell/native-intake-journal';
import { AGENT_NATIVE_INTAKE_POLICY } from '@goodvibes/engine/terminal-shell/native-intake';
export * from '@goodvibes/engine/terminal-shell/native-intake-journal';
export class NativeConversationIntakeJournal extends PlatformJournal {
  constructor(path: string, io: Partial<NativeIntakeJournalIO> = {}) { super(path, io, AGENT_NATIVE_INTAKE_POLICY); }
}

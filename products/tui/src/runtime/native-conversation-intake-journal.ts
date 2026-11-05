import { NativeConversationIntakeJournal as PlatformJournal, type NativeIntakeJournalIO } from '@goodvibes-jev/engine/terminal-shell/native-intake-journal';
export * from '@goodvibes-jev/engine/terminal-shell/native-intake-journal';
export class NativeConversationIntakeJournal extends PlatformJournal {
  constructor(path: string, io: Partial<NativeIntakeJournalIO> = {}) { super(path, io, { allowHosted: false, allowSelectedDiff: true }); }
}

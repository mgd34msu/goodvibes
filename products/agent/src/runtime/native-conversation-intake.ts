import { NativeConversationIntakeControls as PlatformIntake, type NativeConversationIntakeSelection } from '@goodvibes-jev/engine/terminal-shell/native-intake';
export * from '@goodvibes-jev/engine/terminal-shell/native-intake';
export class NativeConversationIntakeControls extends PlatformIntake {
  constructor(select: () => NativeConversationIntakeSelection, newId: () => string = () => crypto.randomUUID()) { super(select, newId, { allowHosted: true, allowSelectedDiff: false }); }
}

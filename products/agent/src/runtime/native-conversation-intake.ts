import { NativeConversationIntakeControls as PlatformIntake, AGENT_NATIVE_INTAKE_POLICY, type NativeConversationIntakeSelection } from '@goodvibes-jev/engine/terminal-shell/native-intake';
export * from '@goodvibes-jev/engine/terminal-shell/native-intake';
export class NativeConversationIntakeControls extends PlatformIntake {
  constructor(select: () => NativeConversationIntakeSelection, newId: () => string = () => crypto.randomUUID()) { super(select, newId, AGENT_NATIVE_INTAKE_POLICY); }
}

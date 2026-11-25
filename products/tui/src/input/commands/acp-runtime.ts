// ---------------------------------------------------------------------------
// acp-runtime.ts, the terminal app's host for `/agents`
// (terminal-shell/agents-command.ts): team modes and recipes
// (teamwork-runtime.ts) and work contracts (control-room-runtime.ts), each a
// session capability (platform builtin/agents.ts) whose control is in the Work
// place. The coding agents the daemon hosts run there through its acp.*
// methods, and coding work handed to the terminal app is the daemon's too.
// ---------------------------------------------------------------------------

import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerAgentsCommand } from '@goodvibes/engine/terminal-shell/agents-command';
import { teamHost } from './teamwork-runtime.ts';
import { contractsHost } from './control-room-runtime.ts';
import { capabilityBinding } from './capability-binding.ts';

export function registerAcpRuntimeCommands(registry: CommandRegistry): void {
  registerAgentsCommand<CommandContext>(registry, {
    contracts: contractsHost(),
    team: teamHost(),
  }, capabilityBinding);
}

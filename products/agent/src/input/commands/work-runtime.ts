import { registerWorkCommand } from '@goodvibes/engine/terminal-shell/native/work-command';
import { capabilityBinding } from './capability-binding.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

export function registerWorkRuntimeCommands(registry: CommandRegistry): void {
  // `/work` (terminal-shell/native/work-command.ts): typed bare it opens the Work place; its work runs on the daemon.
  registerWorkCommand<CommandContext>(registry, {
    view: (ctx) => ctx.nativeWorkLedger,
    // A hosted turn found by an intake step resumes here.
    allowHostedDispatch: true,
    // The Agent's chat goes through the host's intake by itself: what you say there is the request.
    requests: { unavailable: 'In the Agent, say what you want done in the chat: the host makes it a piece of work when it is one. New work, in Work, takes a goal and what done means.' },
  }, capabilityBinding);
}

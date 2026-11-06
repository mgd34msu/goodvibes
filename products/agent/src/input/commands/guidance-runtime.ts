import { createWelcomeCommand } from '@goodvibes-jev/engine/terminal-shell/entry-workspace-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

export function registerGuidanceRuntimeCommands(registry: CommandRegistry): void {
  registry.register(welcomeCommand);
}

const welcomeCommand = createWelcomeCommand<CommandContext>({
  description: 'Open the Agent workspace',
  async open(ctx) {
    if (ctx.executeCommand && (await ctx.executeCommand('agent', []))) return;
    if (ctx.openAgentWorkspace) {
      ctx.openAgentWorkspace();
      return;
    }
    ctx.print('Use /agent to open the Agent workspace.');
    return;
  },
  lines: [
    'Welcome To GoodVibes Agent',
    '  /setup              - open the Agent workspace',
    '  /agent              - open the Agent operator workspace',
    '  /knowledge          - inspect isolated Agent Knowledge status, ask/search, libraries, map, connectors, and ingest paths',
    '  /memory             - manage Agent-local memory',
    '  /personas           - manage Agent-local personas',
    '  /skills             - manage reusable Agent-local skills',
    '  /routines           - manage Agent-local routines',
    '  /delegate           - explicitly hand build/fix/review work to GoodVibes TUI',
  ],
});

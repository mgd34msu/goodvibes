import { registerWorkCommand } from '@goodvibes/engine/terminal-shell/native/work-command';
import { openAgentLegacyImport } from './legacy-work-ledger-import-runtime.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../agent-workspace-categories.ts';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, doAction } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { commandRefusal } from './confirmation.ts';

export function registerAgentWorkspaceRuntimeCommands(registry: CommandRegistry): void {
  // `/work` (terminal-shell/native/work-command.ts): the Agent's work view is a workspace section.
  registerWorkCommand<CommandContext>(registry, {
    view: (ctx) => ctx.nativeWorkLedger,
    open(ctx, project) {
      if (project) ctx.nativeWorkLedger?.selectProject(project);
      if (!ctx.openAgentWorkspace) throw commandRefusal('The Agent workspace needs the interactive shell.');
      ctx.openAgentWorkspace('work');
    },
    // A hosted turn found by an intake step resumes here.
    allowHostedDispatch: true,
    openImport: openAgentLegacyImport,
    requests: { unavailable: 'Work requests, the planner and past plans belong to the terminal app; ask for work in the chat here, or hand coding work on with /agents hand-off.' },
  });
  // `/agent`, described once (command-actions/): one action, the workspace at a section.
  registry.register(defineCommand<CommandContext>({
    name: 'agent',
    title: 'Agent workspace',
    summary: 'Open the Agent workspace, at a section when one is named',
    group: 'Agent',
    actions: [doAction<CommandContext>({
      id: 'open', label: 'Open the Agent workspace', word: '', touches: 'reads',
      inputs: [choiceInput({
        id: 'section', label: 'Section', help: 'Where it opens',
        choices: AGENT_WORKSPACE_CATEGORIES.map((category) => ({ value: category.id, label: category.label })),
        typed: { position: 1 }, optional: { default: '', means: 'where you left it' },
      })],
      sentence: 'Opens the Agent workspace, at the section named.',
      operator: { terminalOnly: 'It is the Agent\'s own screen.' }, example: { section: 'memory' },
      async run(values, ctx) {
        if (!ctx.openAgentWorkspace) throw commandRefusal('The Agent workspace needs the interactive shell.');
        ctx.openAgentWorkspace(values.section || undefined);
      },
    })],
  }));
}

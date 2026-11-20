import { handleNativeIntakeCommand, handleNativeSubmissionCommand } from '@goodvibes-jev/engine/terminal-shell/native/work-command';
import '../../runtime/native-conversation-intake.ts';
import { nativeWorkExecutionLines } from '@goodvibes-jev/engine/terminal-shell/native';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../agent-workspace-categories.ts';
import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, doAction } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { commandRefusal } from './confirmation.ts';

export function registerAgentWorkspaceRuntimeCommands(registry: CommandRegistry): void {
  function openAgentWorkspace(ctx: CommandContext, categoryId: string | undefined): void {
    if (!ctx.openAgentWorkspace) {
      ctx.print('Agent operator workspace is not available in this runtime.');
      return;
    }
    ctx.openAgentWorkspace(categoryId);
  }

  registry.register({
    name: 'work',
    effect: 'ui-navigation',
    description: 'Inspect native work, recover ordinary input, or explicitly start, cancel or resume an existing attempt',
    usage:
      '[daemon-project-id] | start|status|cancel|resume <work-id> | submit-file <JSON-path> | submission-status | submission-retry | submission-discard | intake-status | intake-retry | intake-resume | intake-cancel',
    async handler(args, ctx) {
      const action = args[0];
      if (await handleNativeIntakeCommand(args, ctx, true)) return;
      const view = ctx.nativeWorkLedger;
      const submitFile = view?.submitFile,
        submissionStatus = view?.submissionStatus,
        retrySubmission = view?.retrySubmission,
        discardSubmission = view?.discardSubmission;
      const submission =
        submitFile && submissionStatus && retrySubmission && discardSubmission
          ? {
              submitFile: (path: string) => submitFile.call(view, path),
              status: () => submissionStatus.call(view),
              retry: () => retrySubmission.call(view),
              discard: () => discardSubmission.call(view),
            }
          : undefined;
      if (await handleNativeSubmissionCommand(args, (text) => ctx.print(text), submission)) return;
      if (action === 'start' || action === 'status' || action === 'cancel' || action === 'resume') {
        if (args.length !== 2) {
          throw commandRefusal('Usage: /work start|status|cancel|resume <work-id>');
        }
        if (!ctx.nativeWorkLedger?.execute) {
          throw commandRefusal(`Nothing was run: native execution controls are unavailable on this host, so /work ${action} cannot run here.`, undefined, 'COMMAND_FAILED');
        }
        const result = await ctx.nativeWorkLedger.execute(action, args[1]!);
        const state = ctx.nativeWorkLedger.state;
        const lines = result
          ? nativeWorkExecutionLines(result)
          : [
              state.status !== 'ready'
                ? state.reason
                : 'No new native execution result. A request may already be pending or this action was superseded.',
            ];
        ctx.print(
          (lines.length ? lines : ['No native execution binding is available.'])
            .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' '))
            .join('\n'),
        );
        return;
      }
      if (args.length > 1) {
        throw commandRefusal('Usage: /work [daemon-project-id] | start|status|cancel|resume <work-id>');
      }
      if (args[0]) ctx.nativeWorkLedger?.selectProject(args[0]);
      openAgentWorkspace(ctx, 'work');
    },
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
  registry.register({
    name: 'notes',
    effect: 'ui-navigation',
    aliases: ['scratchpad'],
    description: 'Open Agent-local scratchpad notes in the operator workspace',
    usage: '',
    handler(_args, ctx) {
      openAgentWorkspace(ctx, 'notes');
    },
  });
}

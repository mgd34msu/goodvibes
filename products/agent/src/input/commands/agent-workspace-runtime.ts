import { handleNativeIntakeCommand, handleNativeSubmissionCommand } from '@goodvibes-jev/engine/terminal-shell/native/work-command';
import '../../runtime/native-conversation-intake.ts';
import '../../runtime/native-work-submission.ts';
import { nativeWorkExecutionLines } from '../../runtime/native-work-execution.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { AGENT_WORKSPACE_CATEGORY_IDS } from '../agent-workspace-types.ts';

const AGENT_WORKSPACE_ARGS_HINT = `${AGENT_WORKSPACE_CATEGORY_IDS.join('|')}|connected-host`;

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
    description: 'Inspect native work, recover ordinary input, or explicitly start, cancel or resume an existing attempt',
    usage:
      '[daemon-project-id] | start|status|cancel|resume <work-id> | submit-file <JSON-path> | submission-status | submission-retry | intake-status | intake-retry | intake-resume | intake-cancel',
    async handler(args, ctx) {
      const action = args[0];
      if (await handleNativeIntakeCommand(args, ctx, true)) return;
      const view = ctx.nativeWorkLedger;
      const submitFile = view?.submitFile,
        submissionStatus = view?.submissionStatus,
        retrySubmission = view?.retrySubmission;
      const submission =
        submitFile && submissionStatus && retrySubmission
          ? {
              submitFile: (path: string) => submitFile.call(view, path),
              status: () => submissionStatus.call(view),
              retry: () => retrySubmission.call(view),
            }
          : undefined;
      if (await handleNativeSubmissionCommand(args, (text) => ctx.print(text), submission)) return;
      if (action === 'start' || action === 'status' || action === 'cancel' || action === 'resume') {
        if (args.length !== 2) {
          ctx.print('Usage: /work start|status|cancel|resume <work-id>');
          return;
        }
        if (!ctx.nativeWorkLedger?.execute) {
          ctx.print('Native execution controls are unavailable on this host.');
          return;
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
        ctx.print('Usage: /work [daemon-project-id] | start|status|cancel|resume <work-id>');
        return;
      }
      if (args[0]) ctx.nativeWorkLedger?.selectProject(args[0]);
      openAgentWorkspace(ctx, 'work');
    },
  });
  registry.register({
    name: 'agent',
    aliases: ['home', 'operator'],
    description: 'Open the GoodVibes Agent operator workspace',
    usage: '[category]',
    argsHint: AGENT_WORKSPACE_ARGS_HINT,
    handler(args, ctx) {
      openAgentWorkspace(ctx, args[0]);
    },
  });
  registry.register({
    name: 'notes',
    aliases: ['scratchpad'],
    description: 'Open Agent-local scratchpad notes in the operator workspace',
    usage: '',
    handler(_args, ctx) {
      openAgentWorkspace(ctx, 'notes');
    },
  });
}

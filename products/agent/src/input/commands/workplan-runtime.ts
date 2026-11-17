import { summarizeWorkPlanEdit, type ProjectWorkPlanTaskStatus as WorkPlanItemStatus } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { createAgentWorkPlanTool } from '@goodvibes-jev/engine/terminal-shell/agent-turn/work-plan-tool';
import { isDirectOwnerCommandContext, type CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';

const LOCAL_STATUS: Readonly<Record<string, WorkPlanItemStatus>> = {
  pending: 'pending', start: 'in_progress', blocked: 'blocked', done: 'done', failed: 'failed', cancelled: 'cancelled',
};
type LocalWorkPlanCommand =
  | { readonly action: 'list' }
  | { readonly action: 'create'; readonly title: string; readonly owner: string; readonly source: string; readonly notes: string | undefined }
  | { readonly action: 'set_status'; readonly id: string; readonly status: WorkPlanItemStatus }
  | { readonly action: 'remove'; readonly id: string }
  | { readonly action: 'clear_completed' };

const USAGE = '/workplan show|markdown|add <title> [--owner <label>] [--source <label>] [--notes <text>] | pending|start|blocked|done|failed|cancelled <id> | remove <id> --yes | clear-completed --yes | submit-file <JSON-path> | submission-status | submission-retry | submission-discard';
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');

/** Local todos never become authority. Native source submission remains on the existing owner/journal route. */
export function registerWorkPlanRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workplan',
    effect: 'local-state',
    description: 'Manage local non-executing todos, or explicitly submit original source to native work',
    usage: USAGE.replace('/workplan ', ''),
    async handler(args, ctx) {
      const action = args[0] ?? 'show';
      if (['submit-file', 'submission-status', 'submission-retry', 'submission-discard'].includes(action)) {
        // Share the exact host/principal/source/journal controls, including detached/unknown outcomes.
        await registry.execute('work', args, ctx);
        return;
      }
      const store = ctx.workspace?.workPlan;
      if (!store) throw commandRefusal('Local work plan is unavailable in this shell.', 'Native owner work uses /work submit-file <JSON-path>.');
      let input: LocalWorkPlanCommand;
      if ((action === 'show' || action === 'list') && args.length <= 1) input = { action: 'list' };
      else if (action === 'markdown' && args.length === 1) {
        ctx.print('Local todos only; local done is not native verified completion.');
        ctx.print(store.toMarkdown(await store.snapshot()).split('\n').map(clean).join('\n'));
        return;
      } else if (action === 'add' && args[1]?.trim()) {
        const fields: Record<string, string> = {};
        for (let i = 2; i < args.length; i += 2) {
          const key = args[i]!;
          if (!['--owner', '--source', '--notes'].includes(key) || args[i + 1] === undefined || key in fields) {
            throw commandRefusal(`Usage: ${USAGE}`);
          }
          fields[key] = args[i + 1]!;
        }
        input = { action: 'create', title: args[1], owner: fields['--owner'] || 'owner', source: fields['--source'] || 'manual', notes: fields['--notes'] };
      } else if (Object.hasOwn(LOCAL_STATUS, action) && args.length === 2) {
        input = { action: 'set_status', id: args[1], status: LOCAL_STATUS[action] };
      } else if (action === 'remove' && args.length === 3 && args[2] === '--yes') {
        input = { action: 'remove', id: args[1]! };
      } else if (action === 'clear-completed' && args.length === 2 && args[1] === '--yes') {
        input = { action: 'clear_completed' };
      } else throw commandRefusal(`Usage: ${USAGE}`);
      if (input.action === 'list') {
        const result = await createAgentWorkPlanTool(store).execute({ ...input });
        if (!result.success) throw commandRefusal(clean(result.error ?? 'The local work plan could not be read.'));
        ctx.print((result.output ?? 'No local work-plan result.').split('\n').map(clean).join('\n'));
        return;
      }
      if (!isDirectOwnerCommandContext(ctx, 'workplan')) {
        throw commandRefusal('Local work-plan edits require a fresh terminal owner command; nothing was changed.', 'Ask the owner to type the /workplan line in the terminal.');
      }
      // Each edit is one transaction on the plan's rows; its answer carries the plan's counts.
      if (input.action === 'create') {
        const edit = await store.add(input.title, { owner: input.owner, source: input.source, notes: input.notes });
        ctx.print(`Created local todo ${clean(edit.task.taskId)}: ${clean(edit.task.title)}. Plan: ${summarizeWorkPlanEdit(edit)}. No native work was submitted or executed.`);
      } else if (input.action === 'set_status') {
        const edit = await store.setStatus(input.id, input.status);
        ctx.print(`Local todo ${clean(edit.task.taskId)} is ${clean(edit.task.status)}. Plan: ${summarizeWorkPlanEdit(edit)}. Local done is not native verified completion.`);
      } else if (input.action === 'remove') {
        const removed = await store.remove(input.id);
        ctx.print(`Removed local todo ${clean(removed.deletedTask.taskId)}. Plan: ${summarizeWorkPlanEdit(removed)}.`);
      } else {
        const result = await store.clearCompleted();
        ctx.print(`Cleared ${result.clearedTaskIds?.length ?? 0} completed/cancelled local todos.`);
      }
    },
  });
}

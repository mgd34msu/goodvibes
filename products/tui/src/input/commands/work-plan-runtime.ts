import type { CommandRegistry } from '../command-registry.ts';
import type { WorkPlanItemStatus, WorkPlanStore } from '@goodvibes-jev/engine/platform/platform/workflow';
import { openModalCommand } from './runtime-services.ts';
import { RefusalError, readRefusal, refusal, toRefusal } from '@goodvibes-jev/engine/errors';

const STATUS_COMMANDS: Record<string, WorkPlanItemStatus> = {
  pending: 'pending',
  todo: 'pending',
  start: 'in_progress',
  in_progress: 'in_progress',
  active: 'in_progress',
  progress: 'in_progress',
  block: 'blocked',
  blocked: 'blocked',
  done: 'done',
  complete: 'done',
  fail: 'failed',
  failed: 'failed',
  cancel: 'cancelled',
  cancelled: 'cancelled',
};

function getStore(ctx: import('../command-registry.ts').CommandContext): WorkPlanStore | null {
  return ctx.workspace.workPlanStore ?? null;
}

function openWorkPlanModal(ctx: import('../command-registry.ts').CommandContext): void {
  // work-plan migrated to the 'work-plan' modal, open it via the seam.
  openModalCommand(ctx, 'work-plan-modal');
}

function formatList(store: WorkPlanStore): string {
  const items = store.listItems();
  if (items.length === 0) return 'Work plan is empty. Add one with /work-plan add <title>.';
  return [
    `Work Plan (${items.length})`,
    ...items.map((item) => {
      const owner = item.owner ? ` @${item.owner}` : '';
      return `  ${item.id}  ${item.status.padEnd(11)} ${item.title}${owner}`;
    }),
  ].join('\n');
}

/**
 * Hands an incomplete command back to the person who typed it (or pressed the
 * Work Plan modal's add/edit key) so they finish it in the composer instead of
 * retyping it. Never for a model's call, and never over text already there.
 */
function offerDraft(ctx: import('../command-registry.ts').CommandContext, text: string): void {
  if (ctx.invokedByModel === true) return;
  ctx.restoreDraft?.(text);
}

function parseAddArgs(args: string[]): { title: string; owner?: string; source?: string; notes?: string } {
  const titleParts: string[] = [];
  let owner: string | undefined;
  let source: string | undefined;
  let notes: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const part = args[i] ?? '';
    if (part === '--owner' && args[i + 1]) {
      owner = args[++i];
      continue;
    }
    if (part === '--source' && args[i + 1]) {
      source = args[++i];
      continue;
    }
    if (part === '--notes' && args[i + 1]) {
      notes = args.slice(i + 1).join(' ').trim();
      break;
    }
    titleParts.push(part);
  }
  return {
    title: titleParts.join(' ').trim(),
    ...(owner ? { owner } : {}),
    ...(source ? { source } : {}),
    ...(notes ? { notes } : {}),
  };
}

function usage(reason: string): RefusalError {
  return new RefusalError(refusal({ code: 'USAGE', state: 'nothing was changed', reason, next: ['/work-plan list shows the current items'] }));
}

export function registerWorkPlanRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'work-plan',
    aliases: ['wp', 'todo', 'workplan'],
    description: 'Track a persistent workspace-scoped work plan',
    usage: '[panel|list|show|export|add <title> [--owner name] [--source label] [--notes text]|edit <id> [<new title>] [--owner name] [--source label] [--notes text]|cycle <id>|done <id>|start <id>|in_progress <id>|block <id>|fail <id>|cancel <id>|pending <id>|remove <id>|clear-done]',
    argsHint: '[panel|add|list|done]',
    handler(args, ctx) {
      const store = getStore(ctx);
      if (!store) {
        throw new RefusalError(refusal({ code: 'WORK_PLAN_UNAVAILABLE', state: 'nothing was changed', reason: 'The work plan store is not available in this runtime' }));
      }
      const subcommand = (args[0] ?? 'panel').toLowerCase();
      try {
        if (subcommand === 'panel' || subcommand === 'open') {
          openWorkPlanModal(ctx);
          ctx.print('Opened the work plan.');
          return;
        }
        if (subcommand === 'list') {
          ctx.print(formatList(store));
          return;
        }
        if (subcommand === 'show' || subcommand === 'markdown') {
          ctx.print(store.toMarkdown());
          return;
        }
        if (subcommand === 'export') {
          // Writes the plan's markdown beside the JSON store and reports the
          // path; the Work Plan modal's `x` closes the modal and runs this.
          const { path } = store.exportMarkdown();
          ctx.print(`Exported work plan markdown to ${path}`);
          return;
        }
        if (subcommand === 'add') {
          const parsed = parseAddArgs(args.slice(1));
          if (!parsed.title) {
            const line = 'Usage: /work-plan add <title> [--owner name] [--source label] [--notes text]';
            if (args.length !== 1) throw usage(line);
            // Bare `add` hands the line back in the composer to finish.
            ctx.print(line);
            offerDraft(ctx, '/work-plan add ');
            return;
          }
          const addOptions = {
            ...(parsed.owner ? { owner: parsed.owner } : {}),
            source: parsed.source ?? 'manual',
            ...(parsed.notes ? { notes: parsed.notes } : {}),
          };
          const item = store.addItem(parsed.title, addOptions);
          openWorkPlanModal(ctx);
          ctx.print(`Added work plan item ${item.id}.`);
          return;
        }
        if (subcommand === 'edit' || subcommand === 'update') {
          // Only the flags the caller supplies are patched. With an id and
          // nothing else (the Work Plan modal's `e`), the item's current title
          // is handed back in the composer to change.
          const id = args[1];
          if (!id) {
            throw usage(`Usage: /work-plan ${subcommand} <id> [<new title>] [--owner name] [--source label] [--notes text]`);
          }
          const parsed = parseAddArgs(args.slice(2));
          const patch = {
            ...(parsed.title ? { title: parsed.title } : {}),
            ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}),
            ...(parsed.source !== undefined ? { source: parsed.source } : {}),
            ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
          };
          if (Object.keys(patch).length === 0) {
            const line = `Usage: /work-plan ${subcommand} <id> [<new title>] [--owner name] [--source label] [--notes text]`;
            const items = args.length === 2 ? store.listItems() : [];
            const matches = items.filter((item) => item.id.startsWith(id));
            const target = items.find((item) => item.id === id) ?? (matches.length === 1 ? matches[0]! : null);
            if (!target) throw usage(args.length === 2 ? `No work plan item matches ${id}` : line);
            ctx.print(line);
            offerDraft(ctx, `/work-plan edit ${target.id} ${target.title}`);
            return;
          }
          const item = store.updateItem(id, patch);
          ctx.print(`Updated work plan item ${item.id}: ${item.title}`);
          return;
        }
        if (subcommand === 'remove' || subcommand === 'delete' || subcommand === 'rm') {
          const id = args[1];
          if (!id) {
            throw usage(`Usage: /work-plan ${subcommand} <id>`);
          }
          const item = store.removeItem(id);
          ctx.print(`Removed work plan item ${item.id}: ${item.title}`);
          return;
        }
        if (subcommand === 'clear-done' || subcommand === 'clear-completed') {
          const count = store.clearCompleted();
          ctx.print(`Cleared ${count} completed/cancelled work plan item${count === 1 ? '' : 's'}.`);
          return;
        }
        if (subcommand === 'cycle' || subcommand === 'toggle') {
          const id = args[1];
          if (!id) {
            throw usage(`Usage: /work-plan ${subcommand} <id>`);
          }
          const item = store.cycleItemStatus(id);
          ctx.print(`Updated ${item.id}: ${item.status}.`);
          return;
        }
        const status = STATUS_COMMANDS[subcommand];
        if (status) {
          const id = args[1];
          if (!id) {
            throw usage(`Usage: /work-plan ${subcommand} <id>`);
          }
          const item = store.setItemStatus(id, status);
          ctx.print(`Updated ${item.id}: ${item.status}.`);
          return;
        }
        throw usage(`Unknown work-plan subcommand: ${subcommand}`);
      } catch (error) {
        // A refusal is thrown, not printed and returned: a typed line shows it, and a modal action reports Failed.
        throw new RefusalError(readRefusal(error) ?? toRefusal(error, {
          code: 'WORK_PLAN_REFUSED', state: 'the work plan was not changed', next: ['/work-plan list shows the current items'],
        }));
      }
    },
  });
}

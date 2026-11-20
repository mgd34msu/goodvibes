import { join } from 'path';
import { createUndoCommands, refuseWhileTurnRuns } from '@goodvibes-jev/engine/terminal-shell/everyday-commands';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { TemplateManager, parseTemplateArgs, type TemplateDeleteResult, type TemplateScope } from '@goodvibes-jev/engine/platform/platform/templates';
import { RefusalError, formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';
import { requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { undoLastRewind, redoLastRewind } from './rewind-runtime.ts';
import { dropFileChange, redoLastFileChange, undoLastFileChange } from '@goodvibes-jev/engine/terminal-shell/recovery-commands';

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register(contentCommands.titleCommand);
  registry.register(undoCommands.undo);
  registry.register(undoCommands.redo);



  registry.register(contentCommands.retryCommand);


  registry.register({
    name: 'template',
    aliases: ['tmpl'],
    description: 'Manage and use prompt templates',
    usage: 'save <name> | use <name> [args] | list | show <name> | edit <name> | delete <name> [--global]',
    argsHint: '<save|use|list|show|edit|delete> [name]',
    subcommands: { save: '<name>', use: '<name> [args]', list: '', show: '<name>', edit: '<name>', delete: '<name> [--global]' },
    confirm(args) {
      if (args[0] !== 'delete') return undefined;
      const name = args.slice(1).find((word) => word !== '--global');
      if (!name) return undefined;
      return args.includes('--global')
        ? { title: `Delete global template ${name}?`, detail: `The global template ${name} is shared by every project; its file is removed for all of them and cannot be recovered.`, confirmLabel: 'Delete' }
        : { title: `Delete template ${name}?`, detail: `This project's template file ${name} is removed and cannot be recovered.`, confirmLabel: 'Delete' };
    },
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const templateManager = new TemplateManager({
        projectRoot: shellPaths.workingDirectory,
        homeDirectory: shellPaths.homeDirectory,
      });
      const sub = args[0];
      const rest = args.slice(1);
      /** The file a template loads from (project before global), or undefined when there is none. */
      const templatePath = (name: string): string | undefined => {
        // Stored names are folded the way TemplateManager.save folds them.
        const stored = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'template';
        const wanted = templateManager.list().filter((entry) => entry.name === stored);
        return (wanted.find((entry) => entry.scope === 'project') ?? wanted[0])?.path;
      };
      /** Opens the template's file in $VISUAL / $EDITOR; without an editor it says where the file is. */
      const editTemplate = (name: string): void => {
        const path = templatePath(name);
        if (!path) {
          ctx.print(`Template not found: ${name}. Run /template list to see the templates, or /template save ${name} to create it.`);
          return;
        }
        if (!ctx.openFileInEditor) {
          ctx.print(`No editor can be opened from this surface. The template is the file ${path}; edit it there, or set $VISUAL or $EDITOR.`);
          return;
        }
        void ctx.openFileInEditor(path).then((exited) => {
          if (exited) ctx.print(`Edited template ${name} (${path}); /template use ${name} reads the saved file.`);
        });
      };
      /** Deletes one scope's template; a refusal is thrown with this command's own next step. */
      const deleteTemplate = (name: string, scope: TemplateScope): void => {
        const deleted: TemplateDeleteResult = templateManager.delete(name, scope);
        if (!deleted.ok) {
          const next = deleted.refusal.code === 'TEMPLATE_ONLY_GLOBAL'
            ? [`/template delete ${deleted.name} --global removes it for every project`]
            : deleted.refusal.next;
          throw new RefusalError({ ...deleted.refusal, next });
        }
        ctx.print(`${deleted.scope === 'global' ? 'Global template' : 'Template'} deleted: ${deleted.name}${deleted.stillLoadsFrom === 'global' ? ' (a global template of that name still loads)' : ''}`);
      };
      /** A list action: through the command when this surface can run one, so the deletion is confirmed once; otherwise directly. */
      const deleteFromList = (name: string, scope: TemplateScope): void => {
        const report = (error: unknown): void => {
          const refused = readRefusal(error);
          ctx.print(refused ? formatRefusal(refused) : `Template not deleted: ${summarizeError(error)}`);
        };
        if (ctx.executeCommand) {
          void ctx.executeCommand('template', ['delete', name, ...(scope === 'global' ? ['--global'] : [])]).catch(report);
          return;
        }
        try { deleteTemplate(name, scope); } catch (error) { report(error); }
      };
      if (!sub || sub === 'list') {
        const templates = templateManager.list();
        if (ctx.openSelection) {
          const actions = new Map([
            ['d', 'delete' as const],
            ['e', 'edit' as const],
          ]);
          const items: SelectionItem[] =
            templates.length === 0
              ? [{ id: '_empty', label: 'No templates saved', detail: 'Use /template save <name>' }]
              : templates.map((t) => ({
                  id: t.name,
                  label: t.shadowsGlobal ? `${t.name} (hides global)` : t.name,
                  detail: t.preview,
                  category: t.scope === 'project' ? 'project' : 'global',
                  actions: '[Del] delete  [Ctrl+E] edit',
                }));
          ctx.openSelection('Templates', items, { allowSearch: true, customActions: actions }, (result) => {
            // The "No templates saved" row is a notice, not a template.
            if (!result || result.item.id === '_empty') return;
            if (result.action === 'delete') {
              // The list holds one entry per name (a project template hides the global one), so its scope is the one shown.
              const entry = templates.find((t) => t.name === result.item.id);
              if (entry) deleteFromList(entry.name, entry.scope);
            } else if (result.action === 'edit') {
              editTemplate(result.item.id);
            } else {
              const content = templateManager.load(result.item.id);
              if (content !== null) ctx.submitTurn?.(content);
              else ctx.print(`Template not found: ${result.item.id}`);
            }
          });
          return;
        }
        ctx.print(
          [
            'Templates:',
            '',
            ...templates.map((t) => `  ${t.scope === 'project' ? '[project]' : '[global] '} ${(t.shadowsGlobal ? `${t.name} (hides global)` : t.name).padEnd(28)} ${t.preview}`),
          ].join('\n'),
        );
        return;
      }
      if (sub === 'save') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template save <name>');
          return;
        }
        try {
          const stored = templateManager.save(
            name,
            ctx.session.conversationManager.getLastUserMessage() || '# Template\n\nReplace this with your template content.\n',
          );
          ctx.print(`Template saved: ${stored}`);
        } catch (e) {
          ctx.print(`Failed to save template: ${summarizeError(e)}`);
        }
        return;
      }
      if (sub === 'use') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template use <name> [args...]');
          return;
        }
        const templateContent = templateManager.load(name);
        if (templateContent === null) {
          ctx.print(`Template not found: ${name}\nRun /template list to see available templates.`);
          return;
        }
        ctx.submitTurn?.(templateManager.expand(templateContent, parseTemplateArgs(rest.slice(1))));
        return;
      }
      if (sub === 'show' || sub === 'edit') {
        const name = rest[0];
        if (!name) {
          ctx.print(`Usage: /template ${sub} <name>`);
          return;
        }
        if (sub === 'edit') {
          editTemplate(name);
          return;
        }
        const content = templateManager.load(name);
        ctx.print(content === null ? `Template not found: ${name}` : `Template: ${name}\n\n${content}`);
        return;
      }
      if (sub === 'delete') {
        const name = rest.find((word) => word !== '--global');
        if (!name) {
          ctx.print('Usage: /template delete <name> [--global]');
          return;
        }
        deleteTemplate(name, rest.includes('--global') ? 'global' : 'project');
        return;
      }
      ctx.print(`Unknown subcommand: ${sub}\nUsage: /template save|use|list|show|edit|delete`);
    },
  });

  // From the core-verb naming pass (MEMORY fragmentation, worst-class
  // collision #2): this command used to be named /memory, colliding with
  // the agent's /memory (an alias that forwards to /recall, the durable
  // cross-session MemoryStore), same command name, two unrelated features.
  // Renamed to /note (this feature manages EPHEMERAL, session-scoped sticky
  // notes pinned across context compaction, an entirely different resource
  // from /recall's durable records). /memory is now registered as an alias
  // of /recall below (memory.ts), matching the agent, so the word means the
  // same thing on both surfaces. See
  // docs/decisions/2026-07-06-core-verb-spec.md (in the platform repo) for the
  // full writeup.
  registry.register({
    name: 'note',
    // A note is kept exactly as typed.
    rawRest: (args) => ((args[0] ?? '').toLowerCase() === 'add' ? 1 : undefined),
    description: 'Manage session notes (pinned across context compaction)',
    usage: '[list|add <text>|remove <id>]',
    argsHint: '[list|add|remove]',
    handler(args, ctx) {
      const sub = args[0] ?? 'list';
      if (sub === 'list' || args.length === 0) {
        const memories = requireSessionMemoryStore(ctx).list();
        ctx.print(
          memories.length === 0
            ? 'No session notes. Use !# prefix or /note add <text> to create one.'
            : [`Session Notes (${memories.length}):`, ...memories.map((m) => `  [${m.id}] ${m.text}`)].join('\n'),
        );
      } else if (sub === 'add') {
        const text = args.slice(1).join(' ').trim();
        if (!text) {
          ctx.print('Usage: /note add <text>');
          return;
        }
        const id = requireSessionMemoryStore(ctx).add(text);
        ctx.print(`Note added: [${id}] ${text}`);
      } else if (sub === 'remove') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /note remove <id>');
          return;
        }
        const store = requireSessionMemoryStore(ctx);
        ctx.print(store.remove(id) ? `Note removed: [${id}]` : `Note not found: ${id}`);
      } else {
        ctx.print(
          'Usage: /note [list|add <text>|remove <id>]\n  /note              — list all session notes\n  /note list         — list all session notes\n  /note add <text>   — add a note without sending a message\n  /note remove <id>  — remove a specific note',
        );
      }
    },
  });
}

import { createSessionContentCommands } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
export const contentCommands = createSessionContentCommands<CommandContext, Record<string, unknown>>({
  paths: requireShellPaths,
  capture: (ctx) => (ctx.session.conversationManager.toJSON() as { messages?: Record<string, unknown>[] }).messages ?? [],
  markdown(messages) {
    return messages.map((m) => ({
      role: String(m.role ?? 'user') as 'user' | 'assistant' | 'system' | 'tool',
      content: Array.isArray(m.content)
        ? (m.content as import('@goodvibes-jev/engine/platform/platform/providers').ContentPart[])
        : String(m.content ?? ''),
      toolCalls: m.toolCalls as import('@goodvibes-jev/engine/platform/platform/types').ToolCall[] | undefined,
      callId: m.callId as string | undefined,
      toolName: m.toolName as string | undefined,
      reasoningContent: m.reasoningContent as string | undefined,
      reasoningSummary: m.reasoningSummary as string | undefined,
      usage: m.usage as { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined,
    }));
  },
  text: (message) => (typeof message.content === 'string' ? message.content : ''),
  role: (message) => String(message.role ?? 'unknown'),
  invalidPath: 'Error: Export path must be within the current directory.',
  exported: (count, path) => `Exported ${count} messages to: ${path}`,
  failed: (_action, error) => 'Export failed: ' + summarizeError(error),
  title: (title) => `Conversation title: ${title}`,
  titleSet: (title) => `Title set to: ${title}`,
  retryRemovesLastTurn: false,
});

/** `/undo` and `/redo` are single-action commands shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const undoCommands = createUndoCommands<CommandContext>({
  async undo(values, ctx) {
    const print = (text: string) => ctx.print(text);
    if (values.what === 'file') { undoLastFileChange(ctx.workspace.fileUndoManager, print); return; }
    if (values.what === 'set-aside') { dropFileChange(ctx.workspace.fileUndoManager, 'undo', print); return; }
    if (values.what === 'rewind')  return (await undoLastRewind(ctx)).message; 
    refuseWhileTurnRuns(ctx, '/undo');
    if (!ctx.session.conversationManager.undo()) throw commandRefusal('There is nothing to undo.', 'To take back the last file write or edit: /undo file');
    ctx.renderRequest();
    return 'Last turn undone; /redo brings it back.';
  },
  async redo(values, ctx) {
    const print = (text: string) => ctx.print(text);
    if (values.what === 'file') { redoLastFileChange(ctx.workspace.fileUndoManager, print); return; }
    if (values.what === 'set-aside') { dropFileChange(ctx.workspace.fileUndoManager, 'redo', print); return; }
    if (values.what === 'rewind')  return (await redoLastRewind(ctx)).message; 
    refuseWhileTurnRuns(ctx, '/redo');
    if (!ctx.session.conversationManager.redo()) throw commandRefusal('There is nothing to redo.', 'To write a reverted file change again: /redo file');
    ctx.renderRequest();
    return 'Turn restored.';
  },
});

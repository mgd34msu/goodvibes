import { createSessionListCommand } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
import { createSessionSaveCommand } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
import { join } from 'path';
import { unlinkSync } from 'node:fs';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { TemplateManager, parseTemplateArgs } from '@goodvibes-jev/engine/platform/platform/templates';
import { requireSessionManager, requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { sessionCommand } from './session.ts';
import { describeSessionLoad, loadSessionWithAgents } from './session-load.ts';
import { undoLastRewind, redoLastRewind } from './rewind-runtime.ts';

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register(contentCommands.exportCommand);

  registry.register(contentCommands.titleCommand);

  registry.register(saveCommand);

  registry.register({
    name: 'load',
    description: 'Load a saved session',
    usage: '<name>',
    argsHint: '<name>',
    async handler(args, ctx) {
      if (!args[0]) {
        ctx.print('Usage: /load <session-name>\nRun /sessions to list available sessions.');
        return;
      }
      const result = await loadSessionWithAgents(ctx, requireSessionManager(ctx), args[0]);
      ctx.renderRequest();
      ctx.print(result.ok ? describeSessionLoad(args[0], result) : result.message);
    },
  });

  registry.register({
    name: 'undo',
    aliases: [],
    description:
      'Undo last action. /undo rewind reverses the last /rewind. /undo file reverts every file the last write/edit call changed. /undo alone removes the last conversation turn',
    usage: '[rewind|file]',
    argsHint: '[rewind|file]',
    async handler(args, ctx) {
      if (args[0] === 'rewind') {
        const result = await undoLastRewind(ctx);
        ctx.print(result.message);
        return;
      }
      if (args[0] === 'file') {
        if (!ctx.workspace.fileUndoManager) {
          ctx.print('File undo not available.');
          return;
        }
        try {
          const result = ctx.workspace.fileUndoManager.undo();
          ctx.print(
            result
              ? `${result.paths.length === 1 ? 'File' : `${result.paths.length} files`} reverted (last ${result.tool} call):\n${result.paths.map((path) => `  ${path}`).join('\n')}\nUse /redo file to re-apply.`
              : 'Nothing to undo. No file operations recorded.',
          );
        } catch (err) {
          ctx.print(`File undo failed: ${summarizeError(err)}`);
        }
        return;
      }
      if (ctx.isGenerating?.()) {
        ctx.print('A turn is still running. Stop it with Esc or let it finish, then /undo.');
        return;
      }
      const success = ctx.session.conversationManager.undo();
      if (success) {
        ctx.print('Last turn undone. Use /redo to restore. Tip: /undo file to revert a file write/edit.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to undo. Tip: use /undo file to revert the last file write/edit.');
      }
    },
  });

  registry.register({
    name: 'redo',
    description:
      'Redo last undone action. /redo rewind re-applies the last undone /rewind. /redo file re-applies the last reverted file. /redo alone restores a conversation turn',
    usage: '[rewind|file]',
    argsHint: '[rewind|file]',
    async handler(args, ctx) {
      if (args[0] === 'rewind') {
        const result = await redoLastRewind(ctx);
        ctx.print(result.message);
        return;
      }
      if (args[0] === 'file') {
        if (!ctx.workspace.fileUndoManager) {
          ctx.print('File redo not available.');
          return;
        }
        try {
          const result = ctx.workspace.fileUndoManager.redo();
          ctx.print(result
            ? `${result.paths.length === 1 ? 'File' : `${result.paths.length} files`} re-applied (${result.tool} call):\n${result.paths.map((path) => `  ${path}`).join('\n')}`
            : 'Nothing to redo.');
        } catch (err) {
          ctx.print(`File redo failed: ${summarizeError(err)}`);
        }
        return;
      }
      if (ctx.isGenerating?.()) {
        ctx.print('A turn is still running. Stop it with Esc or let it finish, then /redo.');
        return;
      }
      const success = ctx.session.conversationManager.redo();
      if (success) {
        ctx.print('Turn restored. Tip: /redo file to re-apply a reverted file.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to redo. Tip: use /redo file to re-apply the last reverted file.');
      }
    },
  });

  registry.register(contentCommands.retryCommand);

  registry.register(sessionsCommand);

  registry.register({
    name: 'template',
    aliases: ['tmpl'],
    description: 'Manage and use prompt templates',
    usage: 'save <name> | use <name> [args] | list | show <name> | edit <name> | delete <name>',
    argsHint: '<save|use|list|show|edit|delete> [name]',
    subcommands: { save: '<name>', use: '<name> [args]', list: '', show: '<name>', edit: '<name>', delete: '<name>' },
    confirm(args) {
      if (args[0] !== 'delete' || !args[1]) return undefined;
      return { title: `Delete template ${args[1]}?`, detail: `The template file ${args[1]} is removed and cannot be recovered.`, confirmLabel: 'Delete' };
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
        ctx.openFileInEditor(path);
        ctx.print(`Opened template ${name} in the editor (${path}); /template use ${name} reads the saved file.`);
      };
      const deleteTemplate = (name: string): void => {
        const deleted = templateManager.delete(name);
        if (!deleted.ok) {
          ctx.print(`${deleted.refusal.reason}. ${deleted.refusal.next[0] ?? ''}`.trim());
          return;
        }
        ctx.print(`Template deleted: ${deleted.name}${deleted.stillLoadsFrom === 'global' ? ' (a global template of that name still loads)' : ''}`);
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
                  label: t.name,
                  detail: t.preview,
                  category: t.scope === 'project' ? 'project' : 'global',
                  actions: '[Del] delete  [Ctrl+E] edit',
                }));
          ctx.openSelection('Templates', items, { allowSearch: true, customActions: actions }, (result) => {
            if (!result) return;
            if (result.action === 'delete') {
              deleteTemplate(result.item.id);
            } else if (result.action === 'edit') {
              editTemplate(result.item.id);
            } else {
              const content = templateManager.load(result.item.id);
              if (content !== null) ctx.submitInput?.(content);
              else ctx.print(`Template not found: ${result.item.id}`);
            }
          });
          return;
        }
        ctx.print(
          [
            'Templates:',
            '',
            ...templates.map((t) => `  ${t.scope === 'project' ? '[project]' : '[global] '} ${t.name.padEnd(28)} ${t.preview}`),
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
        ctx.submitInput?.(templateManager.expand(templateContent, parseTemplateArgs(rest.slice(1))));
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
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template delete <name>');
          return;
        }
        deleteTemplate(name);
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
const contentCommands = createSessionContentCommands<CommandContext, Record<string, unknown>>({
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
  confirmExport: false,
  invalidPath: 'Error: Export path must be within the current directory.',
  exported: (count, path) => `Exported ${count} messages to: ${path}`,
  failed: (_action, error) => 'Export failed: ' + summarizeError(error),
  title: (title) => `Conversation title: ${title}`,
  titleSet: (title) => `Title set to: ${title}`,
  retryDescription: 'Retry the last request while retaining completed work',
  retryRemovesLastTurn: false,
});

const saveCommand = createSessionSaveCommand<CommandContext>({
  manager: requireSessionManager,
  messages: (ctx) => (ctx.session.conversationManager.toJSON() as { messages?: object[] }).messages ?? [],
  extraMeta: () => ({}),
  records: (ctx) => {
    const manager = ctx.ops.agentManager;
    if (!manager) {
      ctx.print('Agent manager is not available in this runtime.');
      return null;
    }
    return manager.exportState();
  },
  description: 'Save current session to .goodvibes/tui/sessions/',
  saved: (rawName, { filePath, sanitizedName }, records) =>
    `Session saved: ${rawName}${sanitizedName !== rawName ? ` (saved as "${sanitizedName}")` : ''}${records > 0 ? ` [${records} agent records]` : ''}\n  → ${filePath}`,
  failed: (error) => 'Failed to save session: ' + summarizeError(error),
});

const sessionsCommand = createSessionListCommand<CommandContext>({
  manager: requireSessionManager,
  forward: (args, ctx) => sessionCommand.handler(args, ctx),
  emptyDetail: 'Use /save [name] to save',
  actions: '[Del] delete',
  options: { allowSearch: true, customActions: new Map([['d', 'delete' as const]]) },
  selected: (ctx, sessionManager, sessions, result) => {
    if (!result) return;
    if (result.action === 'delete') {
      const sessionInfo = sessions.find((s) => s.name === result.item.id);
      if (!sessionInfo) return;
      const remove = (): void => {
        try {
          unlinkSync(sessionInfo.filePath);
          ctx.print(`Session deleted: ${result.item.id}`);
        } catch (e) {
          ctx.print(`Failed to delete session: ${summarizeError(e)}`);
        }
        ctx.renderRequest();
      };
      // Deleting is permanent, so it asks first where a confirm dialog exists.
      if (!ctx.confirm) {
        remove();
        return;
      }
      void ctx
        .confirm({
          title: 'Delete session?',
          body: `This removes "${sessionInfo.name}" and its ${sessionInfo.messageCount} message${sessionInfo.messageCount === 1 ? '' : 's'} from this project.\nIt cannot be undone.`,
          confirmLabel: 'Delete',
          tone: 'danger',
        })
        .then((confirmed) => {
          if (confirmed) remove();
          else ctx.renderRequest();
        });
    } else {
      // The same load as /load, agent records included.
      const name = result.item.id;
      void loadSessionWithAgents(ctx, sessionManager, name).then((loaded) => {
        ctx.renderRequest();
        ctx.print(loaded.ok ? describeSessionLoad(name, loaded) : loaded.message);
      });
    }
  },
  heading: 'Saved sessions:',
});

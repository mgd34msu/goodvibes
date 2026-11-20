/**
 * `/template`, described once (command-actions/): prompt templates kept as
 * files in this project (or for every project), used as your next message
 * with their blanks filled in.
 */
import type { CommandContext } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { TemplateManager, parseTemplateArgs, type TemplateScope } from '@goodvibes-jev/engine/platform/platform/templates';
import { RefusalError, formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type InputDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, doAction, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { requireShellPaths } from './runtime-services.ts';

function managerOf(ctx: CommandContext): TemplateManager {
  const shellPaths = requireShellPaths(ctx);
  return new TemplateManager({ projectRoot: shellPaths.workingDirectory, homeDirectory: shellPaths.homeDirectory });
}

/** The file a template loads from (project before global), or undefined when there is none. */
function templatePath(manager: TemplateManager, name: string): string | undefined {
  // Stored names are folded the way TemplateManager.save folds them.
  const stored = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'template';
  const wanted = manager.list().filter((entry) => entry.name === stored);
  return (wanted.find((entry) => entry.scope === 'project') ?? wanted[0])?.path;
}

/** Opens the template's file in $VISUAL / $EDITOR; without an editor it says where the file is. */
function editTemplate(ctx: CommandContext, manager: TemplateManager, name: string): string | void {
  const path = templatePath(manager, name);
  if (!path) throw commandRefusal(`No template ${name}.`, `/template list shows them; /template save ${name} makes it.`);
  if (!ctx.openFileInEditor) return `No editor can be opened here. The template is the file ${path}; edit it there, or set $VISUAL or $EDITOR.`;
  void ctx.openFileInEditor(path).then((exited) => {
    if (exited) ctx.print(`Edited template ${name} (${path}); /template use ${name} reads the saved file.`);
  });
}

/** Deletes one scope's template; a refusal carries this command's own next step. */
function deleteTemplate(manager: TemplateManager, name: string, scope: TemplateScope): string {
  const deleted = manager.delete(name, scope);
  if (!deleted.ok) {
    const next = deleted.refusal.code === 'TEMPLATE_ONLY_GLOBAL' ? [`/template delete ${deleted.name} --everywhere removes it for every project`] : deleted.refusal.next;
    throw new RefusalError({ ...deleted.refusal, next });
  }
  return `${deleted.scope === 'global' ? 'Template for every project' : 'Template'} deleted: ${deleted.name}${deleted.stillLoadsFrom === 'global' ? ' (one for every project with that name still loads)' : ''}`;
}

const TEMPLATES = defineList<CommandContext>({
  name: 'templates',
  async read(ctx) {
    return managerOf(ctx).list().map((template): ListRow => ({ value: template.name, label: template.name, detail: template.preview, state: template.scope === 'project' ? 'this project' : 'every project' }));
  },
  operator: { terminalOnly: 'Templates are files of this project and this machine.' },
});
const TEMPLATE: InputDescription = listInput({ id: 'template', label: 'Template', help: 'Your templates', list: TEMPLATES });
const LOCAL_ONLY = { terminalOnly: 'Templates are files of this project and this machine.' } as const;

export const templateCommand = defineCommand<CommandContext>({
  name: 'template',
  title: 'Prompt templates',
  summary: 'Prompts you keep and reuse: save your last message as one, use one as your next message, edit or delete one',
  group: 'Conversation',
  report: 'list',
  actions: [
    readAction<CommandContext>({
      id: 'list', label: 'See your templates', word: 'list',
      sentence: 'Lists your templates; picking one in the list sends it as your next message (Del deletes it, Ctrl+E edits it).', operator: LOCAL_ONLY,
      async run(_values, ctx) {
        const manager = managerOf(ctx);
        const templates = manager.list();
        if (ctx.openSelection && ctx.invokedByModel !== true) {
          const items: SelectionItem[] = templates.length === 0
            ? [{ id: '_empty', label: 'No templates saved', detail: 'Save your last message as one: /template save <name>' }]
            : templates.map((template) => ({
                id: template.name,
                label: template.shadowsGlobal ? `${template.name} (hides the one for every project)` : template.name,
                detail: template.preview,
                category: template.scope === 'project' ? 'this project' : 'every project',
                actions: '[Del] delete  [Ctrl+E] edit',
              }));
          ctx.openSelection('Templates', items, { allowSearch: true, customActions: new Map([['d', 'delete' as const], ['e', 'edit' as const]]) }, (result) => {
            // The "No templates saved" row is a notice, not a template.
            if (!result || result.item.id === '_empty') return;
            if (result.action === 'delete') {
              // The list holds one entry per name (a project template hides the global one), so its scope is the one shown.
              const entry = templates.find((template) => template.name === result.item.id);
              if (!entry) return;
              // Through the command, so the deletion is asked once.
              const report = (error: unknown): void => { const refused = readRefusal(error); ctx.print(refused ? formatRefusal(refused) : `Template not deleted: ${summarizeError(error)}`); };
              if (ctx.executeCommand) void ctx.executeCommand('template', ['delete', entry.name, ...(entry.scope === 'global' ? ['--everywhere'] : [])]).catch(report);
              return;
            }
            if (result.action === 'edit') {
              try { const said = editTemplate(ctx, manager, result.item.id); if (said) ctx.print(said); } catch (error) { ctx.print(readRefusal(error) ? formatRefusal(readRefusal(error)!) : summarizeError(error)); }
              return;
            }
            const content = manager.load(result.item.id);
            if (content !== null) ctx.submitTurn?.(content);
            else ctx.print(`No template ${result.item.id}.`);
          });
          return;
        }
        if (templates.length === 0) return 'No templates saved. Save your last message as one: /template save <name>';
        return ['Templates:', '', ...templates.map((template) => `  ${template.scope === 'project' ? '[this project]  ' : '[every project] '} ${(template.shadowsGlobal ? `${template.name} (hides the one for every project)` : template.name).padEnd(28)} ${template.preview}`)].join('\n');
      },
    }),
    doAction<CommandContext>({
      id: 'use', label: 'Use a template as your next message', word: 'use',
      inputs: [TEMPLATE, textInput({ id: 'fill', label: 'Blanks', help: 'Values for its blanks, as name=value pairs', why: 'name=value pairs', typed: { tail: true }, optional: { default: '', means: 'blanks left as they are' } })],
      sentence: 'Template {template}, its blanks filled in, is sent as your next message.', example: { template: 'review-pr', fill: 'pr=123' }, operator: LOCAL_ONLY,
      async run(values, ctx) {
        const manager = managerOf(ctx);
        const content = manager.load(values.template!);
        if (content === null) throw commandRefusal(`No template ${values.template}.`, '/template list shows them.');
        if (!ctx.submitTurn) throw commandRefusal('This surface cannot send a message.');
        ctx.submitTurn(manager.expand(content, parseTemplateArgs(values.fill ? values.fill.split(/\s+/).filter(Boolean) : [])));
      },
    }),
    {
      id: 'save', label: 'Save your last message as a template', word: 'save',
      inputs: [textInput({ id: 'name', label: 'Name', help: 'What to call it', why: 'a name you choose', typed: { position: 1 } })],
      sentence: 'Your last message is kept as template {name} in this project, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'delete', operator: LOCAL_ONLY, example: { name: 'review-pr' },
      async run(values, ctx) {
        try {
          const stored = managerOf(ctx).save(values.name!, ctx.session.conversationManager.getLastUserMessage() || '# Template\n\nReplace this with your template content.\n');
          return `Template saved: ${stored}`;
        } catch (error) {
          throw commandRefusal(`The template was not saved: ${summarizeError(error)}`);
        }
      },
    },
    readAction<CommandContext>({
      id: 'show', label: 'See a template', word: 'show', inputs: [TEMPLATE],
      sentence: 'Shows template {template} as written.', example: { template: 'review-pr' }, operator: LOCAL_ONLY,
      async run(values, ctx) {
        const content = managerOf(ctx).load(values.template!);
        if (content === null) throw commandRefusal(`No template ${values.template}.`, '/template list shows them.');
        return `Template: ${values.template}\n\n${content}`;
      },
    }),
    doAction<CommandContext>({
      id: 'edit', label: 'Edit a template in your editor', word: 'edit', inputs: [TEMPLATE],
      sentence: 'Opens template {template} in your editor; the saved file is what /template use reads.', example: { template: 'review-pr' }, operator: LOCAL_ONLY,
      async run(values, ctx) { return editTemplate(ctx, managerOf(ctx), values.template!); },
    }),
    {
      id: 'delete', label: 'Delete a template', word: 'delete',
      inputs: [TEMPLATE, choiceInput({
        id: 'scope', label: 'Which one', help: 'This project\'s, or the one every project shares',
        choices: [{ value: 'project', label: 'This project\'s' }, { value: 'global', label: 'The one for every project', help: 'Every project loses it.' }],
        typed: { flag: '--everywhere', switchOn: 'global' }, optional: { default: 'project', means: 'this project\'s' },
      })],
      sentence: 'Template {template} ({scope}) is deleted.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', operator: LOCAL_ONLY, example: { template: 'review-pr' },
      async run(values, ctx) { return deleteTemplate(managerOf(ctx), values.template!, (values.scope || 'project') as TemplateScope); },
    },
  ],
});

/**
 * Prompt templates: prompts you keep and reuse, kept as Markdown files in the
 * project (`<project>/.goodvibes/templates/`) or for every project
 * (`~/.goodvibes/templates/`). The store (see, read, delete) is the daemon's
 * to manage, in the caller's project; using a template as your next message,
 * saving your last message as one and editing one in your editor act on the
 * conversation and the screen of the program holding it.
 */
import { parseTemplateArgs, TemplateManager, type TemplateScope } from '../../templates/manager.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

export interface TemplateCapabilityServices {
  /** The templates of a project (and of every project), as the caller's project reads them. */
  readonly templates: { forProject(caller: CapabilityCaller): TemplateManager };
}

export interface TemplateSessionCapabilityServices {
  readonly templateSession?: {
    /** The templates of this program's project. */
    readonly manager: () => TemplateManager;
    /** Send text as the person's next message; false where this program cannot. */
    readonly submit: (text: string) => boolean;
    /** The last message the person sent in this conversation, '' when there is none. */
    readonly lastUserMessage: () => string;
    /** Open a file in the person's editor: what it said, or undefined when it opened one. */
    readonly edit: (path: string, name: string) => string | undefined;
  } | undefined;
}

const TEMPLATE: InputDescription = {
  id: 'template', label: 'Template', help: 'Your templates', kind: 'choice',
  choices: { list: 'templates' as ListName, allowOther: { reason: 'a template name' } }, required: true, typed: { position: 1 },
};
const daemon = (id: string, repeat: 'safe' | 'unsafe') => ({ id, group: 'memory' as const, home: 'daemon' as const, repeat });
const session = (id: string, repeat: 'safe' | 'unsafe') => ({ id, group: 'memory' as const, home: 'session' as const, repeat });

function noTemplate(name: string): CapabilityRefusal {
  return new CapabilityRefusal(`No template ${name}.`, 'Your templates are listed in the Memory and knowledge place.');
}

export const TEMPLATE_LIST: CapabilityDefinition<TemplateCapabilityServices> = {
  capability: daemon('template.list', 'safe'),
  actionId: 'list', label: 'See your templates', word: 'list', inputs: [],
  sentence: 'Lists your templates, this project\'s and every project\'s.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const templates = services.templates.forProject(caller).list();
    if (templates.length === 0) return { text: 'No templates saved yet. Save your last message as one.', data: { templates: [] } };
    return {
      text: ['Templates:', ...templates.map((template) => `  ${template.scope === 'project' ? '[this project]  ' : '[every project] '} ${(template.shadowsGlobal ? `${template.name} (hides the one for every project)` : template.name).padEnd(28)} ${template.preview}`)].join('\n'),
      data: { templates: templates.map((template) => ({ name: template.name, scope: template.scope, preview: template.preview, shadowsGlobal: template.shadowsGlobal })) },
    };
  },
};

export const TEMPLATE_SHOW: CapabilityDefinition<TemplateCapabilityServices> = {
  capability: daemon('template.show', 'safe'),
  actionId: 'show', label: 'See a template', word: 'show', inputs: [TEMPLATE],
  sentence: 'Shows template {template} as written.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { template: 'review-pr' },
  async run(values, services, caller) {
    const content = services.templates.forProject(caller).load(values.template!);
    if (content === null) throw noTemplate(values.template!);
    return { text: `Template: ${values.template}\n\n${content}`, data: { name: values.template, content } };
  },
};

export const TEMPLATE_DELETE: CapabilityDefinition<TemplateCapabilityServices> = {
  capability: daemon('template.delete', 'safe'),
  actionId: 'delete', label: 'Delete a template', word: 'delete',
  inputs: [TEMPLATE, {
    id: 'scope', label: 'Which one', help: 'This project\'s, or the one every project shares', kind: 'choice',
    choices: [{ value: 'project', label: 'This project\'s' }, { value: 'global', label: 'The one for every project', help: 'Every project loses it.' }],
    required: { default: 'project', defaultMeans: 'this project\'s' }, typed: { flag: '--everywhere', switchOn: 'global' },
  }],
  sentence: 'Template {template} ({scope}) is deleted.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { template: 'review-pr' },
  async run(values, services, caller) {
    const deleted = services.templates.forProject(caller).delete(values.template!, (values.scope || 'project') as TemplateScope);
    if (!deleted.ok) {
      const next = deleted.refusal.code === 'TEMPLATE_ONLY_GLOBAL' ? 'Delete the one for every project instead (Which one: The one for every project).' : deleted.refusal.next?.[0];
      throw new CapabilityRefusal(`${deleted.refusal.state}: ${deleted.refusal.reason}.`, next);
    }
    noteListChanged({ list: 'templates', change: 'deleted', id: deleted.name });
    return {
      text: `${deleted.scope === 'global' ? 'Template for every project' : 'Template'} deleted: ${deleted.name}${deleted.stillLoadsFrom === 'global' ? ' (one for every project with that name still loads)' : ''}.`,
      data: { name: deleted.name, scope: deleted.scope },
    };
  },
};

function templateSessionOf(services: TemplateSessionCapabilityServices): NonNullable<TemplateSessionCapabilityServices['templateSession']> {
  if (!services.templateSession) throw new CapabilityRefusal('Templates are used in the terminal app, in the conversation they are sent to.');
  return services.templateSession;
}

export const TEMPLATE_USE: CapabilityDefinition<TemplateSessionCapabilityServices> = {
  capability: session('template.use', 'unsafe'),
  actionId: 'use', label: 'Use a template as your next message', word: 'use',
  inputs: [TEMPLATE, { id: 'fill', label: 'Blanks', help: 'Values for its blanks, as name=value pairs', kind: 'text', freeTextReason: 'name=value pairs', required: { default: '', defaultMeans: 'blanks left as they are' }, typed: { tail: true } }],
  sentence: 'Template {template}, its blanks filled in, is sent as your next message.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { template: 'review-pr', fill: 'pr=123' },
  async run(values, services) {
    const templates = templateSessionOf(services);
    const manager = templates.manager();
    const content = manager.load(values.template!);
    if (content === null) throw noTemplate(values.template!);
    if (!templates.submit(manager.expand(content, parseTemplateArgs(values.fill ? values.fill.split(/\s+/).filter(Boolean) : [])))) {
      throw new CapabilityRefusal('This program cannot send a message here; nothing was sent.');
    }
    return { text: '' };
  },
};

export const TEMPLATE_SAVE: CapabilityDefinition<TemplateSessionCapabilityServices> = {
  capability: session('template.save', 'safe'),
  actionId: 'save', label: 'Save your last message as a template', word: 'save',
  inputs: [
    { id: 'name', label: 'Name', help: 'What to call it', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 } },
    {
      id: 'scope', label: 'For', help: 'This project only, or every project on this machine', kind: 'choice',
      choices: [{ value: 'project', label: 'This project' }, { value: 'global', label: 'Every project', help: 'Every project can use it.' }],
      required: { default: 'project', defaultMeans: 'this project' }, typed: { flag: '--everywhere', switchOn: 'global' },
    },
  ],
  sentence: 'Your last message is kept as template {name} ({scope}); a template already saved under that name there is replaced.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { name: 'review-pr' },
  async run(values, services) {
    const templates = templateSessionOf(services);
    const saved = templates.manager().save(values.name!, templates.lastUserMessage() || '# Template\n\nReplace this with your template content.\n', (values.scope || 'project') as TemplateScope);
    return { text: `${saved.replaced ? 'Template replaced' : 'Template saved'}: ${saved.name} (${saved.scope === 'global' ? 'for every project' : 'in this project'}).` };
  },
};

export const TEMPLATE_EDIT: CapabilityDefinition<TemplateSessionCapabilityServices> = {
  capability: session('template.edit', 'safe'),
  actionId: 'edit', label: 'Edit a template in your editor', word: 'edit', inputs: [TEMPLATE],
  sentence: 'Opens template {template} in your editor; the saved file is what using it reads.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { template: 'review-pr' },
  async run(values, services) {
    const templates = templateSessionOf(services);
    const wanted = templates.manager().list().filter((entry) => entry.name === values.template);
    const path = (wanted.find((entry) => entry.scope === 'project') ?? wanted[0])?.path;
    if (!path) throw noTemplate(values.template!);
    return { text: templates.edit(path, values.template!) ?? '' };
  },
};

export const TEMPLATE_DAEMON_CAPABILITIES: readonly CapabilityDefinition<TemplateCapabilityServices>[] = [TEMPLATE_LIST, TEMPLATE_SHOW, TEMPLATE_DELETE];
export const TEMPLATE_SESSION_CAPABILITIES: readonly CapabilityDefinition<TemplateSessionCapabilityServices>[] = [TEMPLATE_USE, TEMPLATE_SAVE, TEMPLATE_EDIT];

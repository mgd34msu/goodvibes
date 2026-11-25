/**
 * The acts on Agent homes and their starter templates (capabilities/builtin/agent-homes.ts), done by the daemon on
 * the owner's home: the same files the Agent reads when it starts (agent-homes.ts).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { CapabilityRefusal, type ActionValues } from '@goodvibes/engine/platform/platform/capabilities';
import {
  clearAgentRuntimeProfileSelection, createAgentRuntimeProfile, createAgentRuntimeProfileFromDiscovered, createAgentRuntimeProfileTemplateFromDiscovered,
  deleteAgentRuntimeProfile, exportAgentRuntimeProfileTemplate, getAgentRuntimeProfileTemplateFile, importAgentRuntimeProfileTemplate, listAgentRuntimeProfiles,
  listAgentRuntimeProfileTemplates, readAgentRuntimeProfileSelection, resolveAgentRuntimeProfileHome, setAgentRuntimeProfileSelection,
  type AgentRuntimeProfileInfo, type AgentRuntimeProfileTemplateSummary,
} from './agent-homes.js';
import { formatAgentRecordSource } from './record-labels.js';
import { storeStep, storeStepAsync, type StoreAct, type StoreActContext } from './agent-store-common.js';

const homeOf = (context: StoreActContext): string => context.shellPaths.homeDirectory;
const csv = (value: string | undefined): readonly string[] | undefined => value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined;

function homeFacts(profile: AgentRuntimeProfileInfo, nextId: string | undefined) {
  return {
    id: profile.id, home: profile.homeDirectory, createdAt: profile.createdAt ?? '', state: profile.id === nextId ? 'starts-next' : 'kept',
    ...(profile.starterTemplateId ? { starter: profile.starterTemplateId } : {}), ...(profile.starterTemplateName ? { starterName: profile.starterTemplateName } : {}),
  };
}

function starterFacts(template: AgentRuntimeProfileTemplateSummary) {
  return {
    id: template.id, name: template.name, description: template.description, persona: template.personaName,
    skills: [...template.skillNames], routines: [...template.routineNames], vibe: template.vibeIncluded === true,
    state: template.source === 'local' ? 'yours' : 'built-in', ...(template.path ? { path: template.path } : {}),
  };
}

function starterLine(template: AgentRuntimeProfileTemplateSummary): string {
  const origin = template.source === 'local' ? `yours, ${template.path ?? ''}`.replace(/, $/, '') : formatAgentRecordSource(template.source).toLowerCase();
  return [
    `  ${template.id}  [${origin}]`,
    `    ${template.name} - ${template.description}`,
    `    persona ${template.personaName}`,
    `    skills ${template.skillNames.join(', ')}`,
    `    routines ${template.routineNames.join(', ')}`,
    template.vibeIncluded ? '    VIBE.md included' : '',
  ].filter(Boolean).join('\n');
}

/**
 * A file a starter is written to or read from: in the caller's project unless the path is absolute. Only the person
 * may name one outside the project; a model's or a script's stays inside it.
 */
function starterFile(context: StoreActContext, raw: string, purpose: 'read' | 'write'): string {
  if (!isAbsolute(raw) && !raw.startsWith('~/') && !context.projectGiven) {
    throw new CapabilityRefusal(`${raw} names no folder and no project came with the request; nothing was done.`, 'Give the whole path, or ask from the project\'s folder.', 'NO_PROJECT');
  }
  const resolved = context.shellPaths.resolveWorkspacePath(raw);
  if (context.personAsked !== true && !context.shellPaths.isWithinWorkingDirectory(resolved)) {
    throw new CapabilityRefusal(`Not done: ${raw} is outside the project (${context.shellPaths.workingDirectory}); only you can ${purpose} a file there yourself.`);
  }
  return resolved;
}

/** A starter made from the persona, skill and routine files found, for a home or alone. */
function learnedOptions(values: ActionValues) {
  return {
    name: values.title || undefined, description: values.description || undefined, persona: values.persona || undefined,
    skills: csv(values.skills), routines: csv(values.routines), includeVibe: values.vibe === 'yes', replace: values.replace === 'yes',
  };
}

export const HOME_ACTS: Readonly<Record<string, StoreAct>> = {
  async 'agent-home.list'(_values, context) {
    const profiles = storeStep(() => listAgentRuntimeProfiles(homeOf(context)));
    const selected = storeStep(() => readAgentRuntimeProfileSelection(homeOf(context)));
    const next = selected ? `  starts next: ${selected.id}${selected.exists ? '' : ' (its folder is missing)'}` : '  starts next: the base Agent home';
    const text = profiles.length === 0
      ? ['Agent homes', next, '  No separate Agent homes yet: make one with "Make a separate Agent home".'].join('\n')
      : ['Agent homes', next, ...profiles.map((profile) => `  ${profile.id}  home ${profile.homeDirectory}${profile.createdAt ? `  made ${profile.createdAt}` : ''}${profile.starterTemplateId ? `  starter ${profile.starterTemplateId}` : ''}`)].join('\n');
    return { text, data: { homes: profiles.map((profile) => homeFacts(profile, selected?.id)), next: selected?.id ?? null } };
  },
  async 'agent-home.show'(values, context) {
    const profile = storeStep(() => resolveAgentRuntimeProfileHome(homeOf(context), values.home!, { mustExist: true }));
    const info = storeStep(() => listAgentRuntimeProfiles(homeOf(context))).find((entry) => entry.id === profile.id) ?? { ...profile, createdAt: null };
    const selected = storeStep(() => readAgentRuntimeProfileSelection(homeOf(context)));
    return {
      text: [
        `Agent home ${profile.id}`,
        `  home ${profile.homeDirectory}`,
        ...(info.starterTemplateId ? [`  starter: ${info.starterTemplateId} (${info.starterTemplateName ?? info.starterTemplateId})`] : []),
        selected?.id === profile.id ? '  the Agent starts in it next' : '',
        `  launch it once: goodvibes-agent --agent-profile ${profile.id}`,
      ].filter(Boolean).join('\n'),
      data: { home: homeFacts(info, selected?.id) },
    };
  },
  async 'agent-home.next'(_values, context) {
    const selected = storeStep(() => readAgentRuntimeProfileSelection(homeOf(context)));
    return selected
      ? { text: `The next launch of the Agent starts in home ${selected.id}${selected.exists ? '' : ' (its folder is missing)'}.\n  home ${selected.homeDirectory}`, data: { next: selected.id, exists: selected.exists } }
      : { text: 'The next launch of the Agent starts in its base home.', data: { next: null } };
  },
  async 'agent-home.use'(values, context) {
    const previous = storeStep(() => readAgentRuntimeProfileSelection(homeOf(context)));
    const selected = storeStep(() => setAgentRuntimeProfileSelection(homeOf(context), values.home!));
    return {
      text: [
        `The Agent starts in home ${selected.id} from its next launch.`,
        `  home ${selected.homeDirectory}`,
        previous ? `  before: ${previous.id}` : '  before: the base Agent home',
      ].join('\n'),
      data: { next: selected.id, before: previous?.id ?? null },
    };
  },
  async 'agent-home.use-base'(_values, context) {
    const previous = storeStep(() => readAgentRuntimeProfileSelection(homeOf(context)));
    storeStep(() => clearAgentRuntimeProfileSelection(homeOf(context)));
    return {
      text: `The Agent starts in its base home from its next launch.${previous ? `\n  before: ${previous.id}` : ''}`,
      data: { next: null, before: previous?.id ?? null },
    };
  },
  async 'agent-home.create'(values, context) {
    const profile = storeStep(() => createAgentRuntimeProfile(homeOf(context), values.name!, { templateId: values.starter || undefined }));
    const applied = profile.starterTemplateApplication;
    return {
      text: [
        `Made Agent home ${profile.id}`,
        `  home ${profile.homeDirectory}`,
        profile.starterTemplateId ? `  starter: ${profile.starterTemplateId}` : '',
        applied?.vibePath ? `  ${applied.vibePending ? 'VIBE.md (held for review)' : 'VIBE.md'} ${applied.vibePath}` : '',
        ...(applied?.reviewCommands.length ? ['  to review before they apply:', ...applied.reviewCommands.map((line) => `    ${line}`)] : []),
        `  start the Agent in it: "Start the Agent in a home from now on", or once: goodvibes-agent --agent-profile ${profile.id}`,
      ].filter(Boolean).join('\n'),
      data: { home: homeFacts(profile, undefined) },
    };
  },
  async 'agent-home.create-learned'(values, context) {
    const created = await storeStepAsync(() => createAgentRuntimeProfileFromDiscovered(context.shellPaths, {
      profileName: values.name!, templateId: values.starter || undefined, ...learnedOptions(values),
    }));
    return {
      text: [
        `Made Agent home ${created.profile.id} from what the Agent has learned`,
        `  home ${created.profile.homeDirectory}`,
        `  starter: ${created.template.id}`,
        `  persona ${created.template.personaName}`,
        `  skills ${created.template.skillNames.join(', ')}`,
        `  routines ${created.template.routineNames.join(', ')}`,
        created.template.vibeIncluded ? '  VIBE.md included' : '',
        `  launch it once: goodvibes-agent --agent-profile ${created.profile.id}`,
      ].filter(Boolean).join('\n'),
      data: { home: homeFacts(created.profile, undefined), starter: starterFacts(created.template) },
    };
  },
  async 'agent-home.delete'(values, context) {
    const deleted = storeStep(() => deleteAgentRuntimeProfile(homeOf(context), values.home!));
    if (!deleted) throw new CapabilityRefusal(`No Agent home ${values.home}; nothing was deleted.`, 'Your Agent homes are listed in Memory and knowledge.', 'NOT_FOUND');
    return { text: `Deleted Agent home ${values.home}.`, data: { home: values.home } };
  },
  async 'agent-home.starters'(_values, context) {
    const templates = storeStep(() => listAgentRuntimeProfileTemplates(homeOf(context)));
    return { text: [`Starter templates (${templates.length})`, ...templates.map(starterLine)].join('\n'), data: { starters: templates.map(starterFacts) } };
  },
  async 'agent-home.starter'(values, context) {
    const file = storeStep(() => getAgentRuntimeProfileTemplateFile(values.starter!, homeOf(context)));
    const template = file.template;
    return {
      text: [
        `Starter template ${template.id}`,
        `  name ${template.name}`,
        `  description ${template.description}`,
        `  persona ${template.persona.name}`,
        `  skills ${template.skills.map((skill) => skill.name).join(', ')}`,
        `  routines ${template.routines.map((routine) => routine.name).join(', ')}`,
        template.vibe ? '  VIBE.md included' : '',
      ].filter(Boolean).join('\n'),
      data: { starter: { id: template.id, name: template.name, description: template.description, persona: template.persona.name, skills: template.skills.map((skill) => skill.name), routines: template.routines.map((routine) => routine.name), vibe: Boolean(template.vibe) } },
    };
  },
  async 'agent-home.guide'(_values, context) {
    const templates = storeStep(() => listAgentRuntimeProfileTemplates(homeOf(context)));
    const yours = templates.filter((template) => template.source === 'local').length;
    return {
      text: [
        'Writing a starter template',
        `  built-in starters ${templates.length - yours}, yours ${yours}`,
        '',
        '1. Pick a starter to begin from ("See Agent home starter templates").',
        '2. Save it to a file ("Save a starter template to a file").',
        '3. Change its id, name, description, persona, skills, routines and VIBE.md (if any) in that JSON file.',
        '4. Add it back ("Add a starter template from a file").',
        '5. Make an Agent home from it ("Make a separate Agent home", choosing that starter).',
        '',
        'This writes only the Agent\'s own starters and homes on this machine.',
      ].join('\n'),
      data: { builtIn: templates.length - yours, yours },
    };
  },
  async 'agent-home.export-starter'(values, context) {
    const target = starterFile(context, values.path!, 'write');
    if (existsSync(target) && values.overwrite !== 'yes') throw new CapabilityRefusal(`${target} already exists; nothing was written.`, 'Choose to write over it, or give another file.');
    const template = storeStep(() => {
      mkdirSync(dirname(target), { recursive: true });
      return exportAgentRuntimeProfileTemplate(homeOf(context), values.starter!, target, { includeVibe: values.vibe === 'yes', shellPaths: context.shellPaths });
    });
    return {
      text: [`Saved starter ${template.id} to ${template.path ?? target}`, template.vibeIncluded ? '  VIBE.md included' : '', '  change it, then add it back with "Add a starter template from a file".'].filter(Boolean).join('\n'),
      data: { starter: template.id, path: template.path ?? target },
    };
  },
  async 'agent-home.import-starter'(values, context) {
    const source = starterFile(context, values.path!, 'read');
    const template = storeStep(() => importAgentRuntimeProfileTemplate(homeOf(context), source, { replace: values.replace === 'yes' }));
    return { text: `Added starter ${template.id} (yours).\n  make an Agent home from it with "Make a separate Agent home".`, data: { starter: starterFacts(template) } };
  },
  async 'agent-home.starter-learned'(values, context) {
    const template = await storeStepAsync(() => createAgentRuntimeProfileTemplateFromDiscovered(context.shellPaths, { id: values.starter!, ...learnedOptions(values) }));
    return {
      text: [
        `Made starter ${template.id} from what the Agent has learned`,
        `  persona ${template.personaName}`,
        `  skills ${template.skillNames.join(', ')}`,
        `  routines ${template.routineNames.join(', ')}`,
        template.vibeIncluded ? '  VIBE.md included' : '',
        '  make an Agent home from it with "Make a separate Agent home".',
      ].filter(Boolean).join('\n'),
      data: { starter: starterFacts(template) },
    };
  },
};

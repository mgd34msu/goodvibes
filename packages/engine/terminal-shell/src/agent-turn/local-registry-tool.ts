import { assertAgentLocalRegistryWrite, assertAgentLocalRegistryEffectCurrent, createAgentLocalRegistryWriteLifecycle, createAgentLocalRegistryInputProjector } from './local-registry-admission.js';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolExecution, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import type { MemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { AgentPersonaRegistry, type AgentPersonaRecord } from './persona-registry.js';
import { AgentNoteRegistry, type AgentNoteRecord } from './note-registry.js';
import { AgentRoutineRegistry, type AgentRoutineRecord } from './routine-registry.js';
import { AgentSkillRegistry, type AgentSkillBundleRecord, type AgentSkillRecord } from './skill-registry.js';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from './record-labels.js';
import { assertActorMayEnable, assertActorMayMarkReviewed } from './review-authority.js';
import { formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';
import { buildAgentLocalRequirements } from './local-registry-requirements.js';
import {
  AGENT_TOOL_PROVENANCE,
  type AgentLocalRegistryToolArgs,
  readActivation,
  readString,
  readStringList,
  registryError,
  registryOutput,
  requireDescription,
  requireId,
  requireName,
  requireTextField,
  requireUpdateFields,
  invalidAction,
} from './local-registry-args.js';
import { handleMemory, MEMORY_CLASSES, MEMORY_SCOPES } from './local-registry-memory.js';
import { confirmParameter, requestParameter } from './effect-admission.js';

export type AgentLocalRegistryDomain = 'memory' | 'note' | 'persona' | 'skill' | 'skill_bundle' | 'routine';
export type AgentLocalRegistryAction = 'list' | 'search' | 'get' | 'create' | 'update' | 'enable' | 'disable' | 'review' | 'stale' | 'use' | 'clear_active' | 'start' | 'delete';
export type { AgentLocalRegistryToolArgs } from './local-registry-args.js';

const DOMAINS: readonly AgentLocalRegistryDomain[] = ['memory', 'note', 'persona', 'skill', 'skill_bundle', 'routine'];
const ACTIONS: readonly AgentLocalRegistryAction[] = ['list', 'search', 'get', 'create', 'update', 'enable', 'disable', 'review', 'stale', 'use', 'clear_active', 'start', 'delete'];

function isDomain(value: unknown): value is AgentLocalRegistryDomain {
  return typeof value === 'string' && DOMAINS.includes(value as AgentLocalRegistryDomain);
}

function isAction(value: unknown): value is AgentLocalRegistryAction {
  return typeof value === 'string' && ACTIONS.includes(value as AgentLocalRegistryAction);
}

/** No such record is a failure in every domain; the text names how to find a real id. */
function unknownRecord(kind: string, domain: AgentLocalRegistryDomain, args: AgentLocalRegistryToolArgs): Error {
  return new Error(`Unknown Agent-local ${kind} ${readString(args.id)}. Nothing was changed; find ids with domain:"${domain}" action:"list" or action:"search".`);
}

/**
 * A field edit carries `enabled` in the same registry write. `enabled` alone is
 * the registry's own enable/disable, which leaves the review state as it is.
 */
function updateOrSetEnabled<R>(
  fieldsGiven: boolean,
  enabled: unknown,
  update: (enabled: boolean | undefined) => R,
  setEnabled: (enabled: boolean) => R,
): R {
  const flag = typeof enabled === 'boolean' ? enabled : undefined;
  return fieldsGiven || flag === undefined ? update(flag) : setEnabled(flag);
}

function formatNote(note: AgentNoteRecord): string {
  const tags = note.tags.length > 0 ? ` tags ${note.tags.join(', ')}` : '';
  const sourceUrl = note.sourceUrl ? ` source ${note.sourceUrl}` : '';
  return `${note.id}  ${formatAgentRecordReviewState(note.reviewState)}  ${formatAgentRecordOrigin(note.source, note.provenance)}${tags}${sourceUrl}  ${note.title}`;
}

function listNotes(records: readonly AgentNoteRecord[], title: string): string {
  return records.length === 0
    ? `${title}\nNo Agent-local notes.`
    : [title, ...records.map(formatNote)].join('\n');
}

function handleNote(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>): string {
  const registry = AgentNoteRegistry.fromShellPaths(shellPaths, effects);
  if (action === 'list') return listNotes(registry.list(), 'Agent-local notes');
  if (action === 'search') return listNotes(registry.search(readString(args.query)), 'Agent-local notes search');
  if (action === 'get') {
    const note = registry.get(requireId(args));
    if (!note) throw unknownRecord('note', 'note', args);
    return [
      formatNote(note),
      `created ${note.createdAt}`,
      `updated ${note.updatedAt}`,
      `origin ${formatAgentRecordOrigin(note.source, note.provenance)}`,
      '',
      note.body,
    ].join('\n');
  }
  if (action === 'create') {
    const note = registry.create({
      title: requireTextField(args.title ?? args.name ?? args.summary, 'title'),
      body: requireTextField(args.body ?? args.detail ?? args.description, 'body'),
      tags: readStringList(args.tags),
      sourceUrl: readString(args.sourceUrl) || undefined,
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Created Agent-local note',
      `  id ${note.id}`,
      `  title ${note.title}`,
    ].join('\n');
  }
  if (action === 'update') {
    requireUpdateFields('note', { title: args.title ?? args.name ?? args.summary, body: args.body ?? args.detail ?? args.description, tags: args.tags, sourceUrl: args.sourceUrl === undefined ? undefined : true });
    const note = registry.update(requireId(args), {
      title: readString(args.title ?? args.name ?? args.summary) || undefined,
      body: readString(args.body ?? args.detail ?? args.description) || undefined,
      tags: args.tags === undefined ? undefined : readStringList(args.tags),
      sourceUrl: args.sourceUrl === undefined ? undefined : readString(args.sourceUrl),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Updated Agent-local note',
      `  id ${note.id}`,
      `  title ${note.title}`,
    ].join('\n');
  }
  if (action === 'review') {
    const note = registry.markReviewed(requireId(args));
    return [
      'Reviewed Agent-local note',
      `  id ${note.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const note = registry.markStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local note stale',
      `  id ${note.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    const note = registry.deleteNote(requireId(args));
    return [
      'Deleted Agent-local note',
      `  id ${note.id}`,
      `  title ${note.title}`,
    ].join('\n');
  }
  throw new Error(invalidAction(action, 'notes', 'note'));
}

function formatPersona(persona: AgentPersonaRecord, activeId: string | null): string {
  const active = persona.id === activeId ? 'active' : 'inactive';
  return `${persona.id}  ${active}  ${formatAgentRecordReviewState(persona.reviewState)}  ${persona.name} - ${persona.description}`;
}

function formatSkill(skill: AgentSkillRecord): string {
  const enabled = skill.enabled ? 'enabled' : 'disabled';
  return `${skill.id}  ${enabled}  ${formatAgentRecordReviewState(skill.reviewState)}  ${skill.name} - ${skill.description}`;
}

function formatSkillBundle(bundle: AgentSkillBundleRecord): string {
  const enabled = bundle.enabled ? 'enabled' : 'disabled';
  return `${bundle.id}  ${enabled}  ${formatAgentRecordReviewState(bundle.reviewState)}  ${bundle.name} - ${bundle.description} skills ${bundle.skillIds.join(', ')}`;
}

function formatRoutine(routine: AgentRoutineRecord): string {
  const enabled = routine.enabled ? 'enabled' : 'disabled';
  return `${routine.id}  ${enabled}  ${formatAgentRecordReviewState(routine.reviewState)}  starts ${routine.startCount}  ${routine.name} - ${routine.description}`;
}

function listPersonas(registry: AgentPersonaRegistry, records: readonly AgentPersonaRecord[], title: string): string {
  const snapshot = registry.snapshot();
  return records.length === 0
    ? `${title}\nNo Agent-local personas.`
    : [title, ...records.map((persona) => formatPersona(persona, snapshot.activePersonaId))].join('\n');
}

function listSkills(records: readonly AgentSkillRecord[], title: string): string {
  return records.length === 0
    ? `${title}\nNo Agent-local skills.`
    : [title, ...records.map(formatSkill)].join('\n');
}

function listSkillBundles(records: readonly AgentSkillBundleRecord[], title: string): string {
  return records.length === 0
    ? `${title}\nNo Agent-local skill bundles.`
    : [title, ...records.map(formatSkillBundle)].join('\n');
}

function listRoutines(records: readonly AgentRoutineRecord[], title: string): string {
  return records.length === 0
    ? `${title}\nNo Agent-local routines.`
    : [title, ...records.map(formatRoutine)].join('\n');
}

function handlePersona(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>): string {
  const registry = AgentPersonaRegistry.fromShellPaths(shellPaths, effects);
  if (action === 'list') return listPersonas(registry, registry.list(), 'Agent-local personas');
  if (action === 'search') return listPersonas(registry, registry.search(readString(args.query)), 'Agent-local personas search');
  if (action === 'get') {
    const persona = registry.get(requireId(args));
    if (!persona) throw unknownRecord('persona', 'persona', args);
    return [
      formatPersona(persona, registry.snapshot().activePersonaId),
      `origin ${formatAgentRecordOrigin(persona.source, persona.provenance)}`,
      `triggers ${persona.triggers.join(', ') || '(manual)'}`,
      `tags ${persona.tags.join(', ') || '(none)'}`,
      '',
      persona.body,
    ].join('\n');
  }
  if (action === 'create') {
    const activate = readActivation(args.activate);
    // Saved and, when asked, made active in one write.
    const persona = registry.create({
      name: requireName(args),
      description: requireDescription(args),
      body: requireTextField(args.body, 'body'),
      tags: readStringList(args.tags),
      triggers: readStringList(args.triggers),
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
      ...(activate === true ? { active: true } : {}),
    });
    return [
      'Created Agent-local persona',
      `  id ${persona.id}`,
      `  name ${persona.name}`,
    ].join('\n');
  }
  if (action === 'update') {
    const activate = readActivation(args.activate);
    requireUpdateFields('persona', { name: args.name, description: args.description, body: args.body, tags: args.tags, triggers: args.triggers, activate: activate });
    // The edit and the active-state change are one write.
    const persona = registry.update(requireId(args), {
      name: readString(args.name) || undefined,
      description: readString(args.description) || undefined,
      body: readString(args.body) || undefined,
      tags: args.tags === undefined ? undefined : readStringList(args.tags),
      triggers: args.triggers === undefined ? undefined : readStringList(args.triggers),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
      ...(activate === undefined ? {} : { active: activate }),
    });
    return [
      'Updated Agent-local persona',
      `  id ${persona.id}`,
      `  name ${persona.name}`,
    ].join('\n');
  }
  if (action === 'use') {
    const persona = registry.setActive(requireId(args));
    return [
      'Active Agent-local persona set',
      `  id ${persona.id}`,
      `  name ${persona.name}`,
    ].join('\n');
  }
  if (action === 'clear_active') {
    registry.clearActive();
    return 'Cleared active Agent-local persona.';
  }
  if (action === 'review') {
    assertActorMayMarkReviewed('model', 'persona', requireId(args));
    const persona = registry.markReviewed(requireId(args));
    return [
      'Reviewed Agent-local persona',
      `  id ${persona.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const persona = registry.markStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local persona stale',
      `  id ${persona.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    const persona = registry.deletePersona(requireId(args));
    return [
      'Deleted Agent-local persona',
      `  id ${persona.id}`,
      `  name ${persona.name}`,
    ].join('\n');
  }
  throw new Error(invalidAction(action, 'personas', 'persona'));
}

function handleSkill(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>): string {
  const registry = AgentSkillRegistry.fromShellPaths(shellPaths, effects);
  if (action === 'list') return listSkills(registry.list(), 'Agent-local skills');
  if (action === 'search') return listSkills(registry.search(readString(args.query)), 'Agent-local skills search');
  if (action === 'get') {
    const skill = registry.get(requireId(args));
    if (!skill) throw unknownRecord('skill', 'skill', args);
    return [
      formatSkill(skill),
      `origin ${formatAgentRecordOrigin(skill.source, skill.provenance)}`,
      `provenance: ${skill.provenance}`,
      `triggers ${skill.triggers.join(', ') || '(manual)'}`,
      `tags ${skill.tags.join(', ') || '(none)'}`,
      '',
      skill.procedure,
    ].join('\n');
  }
  if (action === 'create') {
    if (args.enabled === true) assertActorMayEnable('model', 'skill', requireName(args), 'fresh');
    const skill = registry.create({
      name: requireName(args),
      description: requireDescription(args),
      procedure: requireTextField(args.procedure, 'procedure'),
      triggers: readStringList(args.triggers),
      tags: readStringList(args.tags),
      requirements: buildAgentLocalRequirements(args.requiresEnv, args.requiresCommands),
      enabled: args.enabled === true,
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      `Created Agent-local skill ${skill.id}`,
      `  id ${skill.id}`,
      `  name ${skill.name}`,
    ].join('\n');
  }
  if (action === 'update') {
    const id = requireId(args);
    // An edit returns the skill to unreviewed, so enabling in the same call needs the owner.
    if (args.enabled === true) assertActorMayEnable('model', 'skill', id, [args.name, args.description, args.procedure, args.triggers, args.tags,
      args.requiresEnv, args.requiresCommands].some((value) => value !== undefined) ? 'fresh' : registry.get(id)?.reviewState);
    requireUpdateFields('skill', { name: args.name, description: args.description, procedure: args.procedure, triggers: args.triggers, tags: args.tags,
      requiresEnv: args.requiresEnv, requiresCommands: args.requiresCommands, enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined });
    const fieldsGiven = [args.name, args.description, args.procedure, args.triggers, args.tags, args.requiresEnv, args.requiresCommands].some((value) => value !== undefined);
    const skill = updateOrSetEnabled(fieldsGiven, args.enabled, (enabled) => registry.update(id, {
      name: readString(args.name) || undefined,
      description: readString(args.description) || undefined,
      procedure: readString(args.procedure) || undefined,
      triggers: args.triggers === undefined ? undefined : readStringList(args.triggers),
      tags: args.tags === undefined ? undefined : readStringList(args.tags),
      requirements: buildAgentLocalRequirements(args.requiresEnv, args.requiresCommands, registry.get(id)?.requirements),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
      enabled,
    }), (enabled) => registry.setEnabled(id, enabled));
    return [
      'Updated Agent-local skill',
      `  id ${skill.id}`,
      `  name ${skill.name}`,
    ].join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    if (action === 'enable') assertActorMayEnable('model', 'skill', requireId(args), registry.get(requireId(args))?.reviewState);
    const skill = registry.setEnabled(requireId(args), action === 'enable');
    return [
      `${action === 'enable' ? 'Enabled' : 'Disabled'} Agent-local skill`,
      `  id ${skill.id}`,
      `  name ${skill.name}`,
    ].join('\n');
  }
  if (action === 'review') {
    assertActorMayMarkReviewed('model', 'skill', requireId(args));
    const skill = registry.markReviewed(requireId(args));
    return [
      'Reviewed Agent-local skill',
      `  id ${skill.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const skill = registry.markStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local skill stale',
      `  id ${skill.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    const skill = registry.deleteSkill(requireId(args));
    return [
      'Deleted Agent-local skill',
      `  id ${skill.id}`,
      `  name ${skill.name}`,
    ].join('\n');
  }
  throw new Error(invalidAction(action, 'skills', 'skill'));
}

function handleSkillBundle(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>): string {
  const registry = AgentSkillRegistry.fromShellPaths(shellPaths, effects);
  if (action === 'list') return listSkillBundles(registry.listBundles(), 'Agent-local skill bundles');
  if (action === 'search') return listSkillBundles(registry.searchBundles(readString(args.query)), 'Agent-local skill bundles search');
  if (action === 'get') {
    const bundle = registry.getBundle(requireId(args));
    if (!bundle) throw unknownRecord('skill bundle', 'skill_bundle', args);
    return [
      formatSkillBundle(bundle),
      `origin ${formatAgentRecordOrigin(bundle.source, bundle.provenance)}`,
      `skills ${bundle.skillIds.join(', ')}`,
      '',
      bundle.description,
    ].join('\n');
  }
  if (action === 'create') {
    if (args.enabled === true) assertActorMayEnable('model', 'skill bundle', requireName(args), 'fresh');
    const bundle = registry.createBundle({
      name: requireName(args),
      description: requireDescription(args),
      skillIds: readStringList(args.skillIds ?? args.skills),
      enabled: args.enabled === true,
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      `Created Agent-local skill bundle ${bundle.id}`,
      `  id ${bundle.id}`,
      `  name ${bundle.name}`,
    ].join('\n');
  }
  if (action === 'update') {
    const id = requireId(args);
    if (args.enabled === true) assertActorMayEnable('model', 'skill bundle', id,
      [args.name, args.description, args.skillIds, args.skills].some((value) => value !== undefined) ? 'fresh' : registry.getBundle(id)?.reviewState);
    requireUpdateFields('skill bundle', { name: args.name, description: args.description, skillIds: args.skillIds ?? args.skills, enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined });
    const fieldsGiven = [args.name, args.description, args.skillIds, args.skills].some((value) => value !== undefined);
    const bundle = updateOrSetEnabled(fieldsGiven, args.enabled, (enabled) => registry.updateBundle(id, {
      name: readString(args.name) || undefined,
      description: readString(args.description) || undefined,
      skillIds: args.skillIds === undefined && args.skills === undefined ? undefined : readStringList(args.skillIds ?? args.skills),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
      enabled,
    }), (enabled) => registry.setBundleEnabled(id, enabled));
    return [
      'Updated Agent-local skill bundle',
      `  id ${bundle.id}`,
      `  name ${bundle.name}`,
    ].join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    if (action === 'enable') assertActorMayEnable('model', 'skill bundle', requireId(args), registry.getBundle(requireId(args))?.reviewState);
    const bundle = registry.setBundleEnabled(requireId(args), action === 'enable');
    return [
      `${action === 'enable' ? 'Enabled' : 'Disabled'} Agent-local skill bundle`,
      `  id ${bundle.id}`,
      `  name ${bundle.name}`,
    ].join('\n');
  }
  if (action === 'review') {
    assertActorMayMarkReviewed('model', 'skill bundle', requireId(args));
    const bundle = registry.markBundleReviewed(requireId(args));
    return [
      'Reviewed Agent-local skill bundle',
      `  id ${bundle.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const bundle = registry.markBundleStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local skill bundle stale',
      `  id ${bundle.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    const bundle = registry.deleteBundle(requireId(args));
    return [
      'Deleted Agent-local skill bundle',
      `  id ${bundle.id}`,
      `  name ${bundle.name}`,
    ].join('\n');
  }
  throw new Error(invalidAction(action, 'skill bundles', 'skill_bundle'));
}

function handleRoutine(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>): string {
  const registry = AgentRoutineRegistry.fromShellPaths(shellPaths, effects);
  if (action === 'list') return listRoutines(registry.list(), 'Agent-local routines');
  if (action === 'search') return listRoutines(registry.search(readString(args.query)), 'Agent-local routines search');
  if (action === 'get') {
    const routine = registry.get(requireId(args));
    if (!routine) throw unknownRecord('routine', 'routine', args);
    return [
      formatRoutine(routine),
      `origin ${formatAgentRecordOrigin(routine.source, routine.provenance)}`,
      `triggers ${routine.triggers.join(', ') || '(manual)'}`,
      `tags ${routine.tags.join(', ') || '(none)'}`,
      '',
      routine.steps,
    ].join('\n');
  }
  if (action === 'create') {
    if (args.enabled === true) assertActorMayEnable('model', 'routine', requireName(args), 'fresh');
    const routine = registry.create({
      name: requireName(args),
      description: requireDescription(args),
      steps: requireTextField(args.steps, 'steps'),
      triggers: readStringList(args.triggers),
      tags: readStringList(args.tags),
      requirements: buildAgentLocalRequirements(args.requiresEnv, args.requiresCommands),
      enabled: args.enabled === true,
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Created Agent-local routine',
      `  id ${routine.id}`,
      `  name ${routine.name}`,
    ].join('\n');
  }
  if (action === 'update') {
    const id = requireId(args);
    if (args.enabled === true) assertActorMayEnable('model', 'routine', id, [args.name, args.description, args.steps, args.triggers, args.tags,
      args.requiresEnv, args.requiresCommands].some((value) => value !== undefined) ? 'fresh' : registry.get(id)?.reviewState);
    requireUpdateFields('routine', { name: args.name, description: args.description, steps: args.steps, triggers: args.triggers, tags: args.tags,
      requiresEnv: args.requiresEnv, requiresCommands: args.requiresCommands, enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined });
    const fieldsGiven = [args.name, args.description, args.steps, args.triggers, args.tags, args.requiresEnv, args.requiresCommands].some((value) => value !== undefined);
    const routine = updateOrSetEnabled(fieldsGiven, args.enabled, (enabled) => registry.update(id, {
      name: readString(args.name) || undefined,
      description: readString(args.description) || undefined,
      steps: readString(args.steps) || undefined,
      triggers: args.triggers === undefined ? undefined : readStringList(args.triggers),
      tags: args.tags === undefined ? undefined : readStringList(args.tags),
      requirements: buildAgentLocalRequirements(args.requiresEnv, args.requiresCommands, registry.get(id)?.requirements),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
      enabled,
    }), (enabled) => registry.setEnabled(id, enabled));
    return [
      'Updated Agent-local routine',
      `  id ${routine.id}`,
      `  name ${routine.name}`,
    ].join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    if (action === 'enable') assertActorMayEnable('model', 'routine', requireId(args), registry.get(requireId(args))?.reviewState);
    const routine = registry.setEnabled(requireId(args), action === 'enable');
    return [
      `${action === 'enable' ? 'Enabled' : 'Disabled'} Agent-local routine`,
      `  id ${routine.id}`,
      `  name ${routine.name}`,
    ].join('\n');
  }
  if (action === 'start') {
    const routine = registry.markStarted(requireId(args));
    return [
      'Started Agent-local routine',
      `  id ${routine.id}`,
      `  name ${routine.name}`,
      'Policy: same main conversation; no hidden background job, connected-host mutation, or external side effect was started.',
      '',
      routine.steps,
    ].join('\n');
  }
  if (action === 'review') {
    assertActorMayMarkReviewed('model', 'routine', requireId(args));
    const routine = registry.markReviewed(requireId(args));
    return [
      'Reviewed Agent-local routine',
      `  id ${routine.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const routine = registry.markStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local routine stale',
      `  id ${routine.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    const routine = registry.deleteRoutine(requireId(args));
    return [
      'Deleted Agent-local routine',
      `  id ${routine.id}`,
      `  name ${routine.name}`,
    ].join('\n');
  }
  throw new Error(invalidAction(action, 'routines', 'routine'));
}

export function createAgentLocalRegistryTool(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, memorySpine: MemoryAccess): Tool {
  return {
    definition: {
      name: 'agent_local_registry',
      activity: {
        doing: 'Checking', did: 'checked', object: 'notes & routines',
        byAction: {
          change: { doing: 'Updating', did: 'updated', object: 'notes & routines' },
          run: { doing: 'Using', did: 'used', object: 'notes & routines' },
          delete: { doing: 'Deleting from', did: 'deleted from', object: 'notes & routines' },
        },
      },
      description: 'Inspect or update Agent-local records by domain. Actions per domain: memory, note: list, search, get, create, update, review, stale, delete. persona adds use and clear_active. skill and skill_bundle add enable and disable. routine adds enable, disable and start. Create needs: memory summary; note title and body; persona name, description and body; skill name, description and procedure; skill_bundle name, description and skillIds; routine name, description and steps. Writes need current recorded admission. Marking a persona, skill, skill bundle or routine reviewed, and enabling one nobody reviewed, are the owner\'s: refused here with the command the owner types.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', enum: [...DOMAINS], description: 'Which kind of record to work on.' },
          action: { type: 'string', enum: [...ACTIONS], description: 'What to do; each domain accepts only some actions (see the tool description).' },
          id: { type: 'string', description: 'Record id for get, update, review, stale, delete, use, enable, disable and start.' },
          query: { type: 'string', description: 'Search text for action search.' },
          limit: { type: 'number', description: 'Memory list or search: maximum rows (search default 10, at most 50).' },
          semantic: { type: 'boolean', description: 'Memory search: semantic by default; false forces literal matching.' },
          cls: { type: 'string', enum: [...MEMORY_CLASSES], description: 'Memory class when domain is memory.' },
          scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'Memory scope when domain is memory.' },
          summary: { type: 'string', description: 'Memory summary when domain is memory.' },
          detail: { type: 'string', description: 'Memory detail when domain is memory.' },
          confidence: { type: 'number', description: 'Memory review confidence from 0 to 100.' },
          title: { type: 'string', description: 'Note title when domain is note.' },
          name: { type: 'string', description: 'Name of a persona, skill, skill_bundle or routine.' },
          description: { type: 'string', description: 'Description of a persona, skill, skill_bundle or routine.' },
          body: { type: 'string', description: 'Note body or persona body/instructions.' },
          sourceUrl: { type: 'string', description: 'Optional source URL when domain is note.' },
          procedure: { type: 'string', description: 'Skill procedure.' },
          steps: { type: 'string', description: 'Routine steps.' },
          skills: { type: 'array', items: { type: 'string' }, description: 'Skill ids for skill_bundle create/update.' },
          skillIds: { type: 'array', items: { type: 'string' }, description: 'Skill ids for skill_bundle create/update.' },
          requiresEnv: { type: 'array', items: { type: 'string' }, description: 'Required environment variable names.' },
          requiresCommands: { type: 'array', items: { type: 'string' }, description: 'Command names required by a skill or routine.' },
          triggers: { type: 'array', items: { type: 'string' }, description: 'Trigger phrases for a persona, skill or routine.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags on any record.' },
          reason: { type: 'string', description: 'Why a record is marked stale.' },
          enabled: { type: 'boolean', description: 'Skill, skill_bundle or routine: initial state on create, or the new state on update.' },
          activate: { type: 'boolean', description: 'Persona create or update: true makes it the active persona, false clears it if it is active.' },
          provenance: { type: 'string', description: 'Where the record came from.' },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        required: ['domain', 'action'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (rawArgs, options) => {
      const args: AgentLocalRegistryToolArgs = rawArgs;
      if (!isDomain(args.domain)) return registryError(`Unknown domain. Valid values ${DOMAINS.join(', ')}.`);
      if (!isAction(args.action)) return registryError(`Unknown action. Valid values ${ACTIONS.join(', ')}.`);
      const action = args.action;
      try {
        options?.signal?.throwIfAborted(); assertCurrentToolExecution(rawArgs, options);
        if (!['list', 'search', 'get'].includes(args.action)) assertAgentLocalRegistryWrite(rawArgs, options);
        if (args.domain === 'memory') {
          const result = await handleMemory(memoryRegistry, memorySpine, args.action, args, {
            signal: options?.signal,
            assertCurrent: () => {
              options?.signal?.throwIfAborted();
              if (['list', 'search', 'get'].includes(action)) assertCurrentToolExecution(rawArgs, options);
              else assertAgentLocalRegistryEffectCurrent(rawArgs, options);
            },
          });
          options?.signal?.throwIfAborted(); assertCurrentToolExecution(rawArgs, options);
          return registryOutput(result);
        }
        const effects = createAgentLocalRegistryWriteLifecycle(rawArgs, options);
        if (args.domain === 'note') return registryOutput(handleNote(shellPaths, args.action, args, effects));
        if (args.domain === 'persona') return registryOutput(handlePersona(shellPaths, args.action, args, effects));
        if (args.domain === 'skill') return registryOutput(handleSkill(shellPaths, args.action, args, effects));
        if (args.domain === 'skill_bundle') return registryOutput(handleSkillBundle(shellPaths, args.action, args, effects));
        return registryOutput(handleRoutine(shellPaths, args.action, args, effects));
      } catch (error) {
        const refused = readRefusal(error);
        return registryError(refused ? formatRefusal(refused) : error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentLocalRegistryTool(registry: ToolRegistry, shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, memorySpine: MemoryAccess): void {
  registry.register(createAgentLocalRegistryTool(shellPaths, memoryRegistry, memorySpine),
    { inputProjection: createAgentLocalRegistryInputProjector(shellPaths, memoryRegistry, memorySpine) });
}

import { assertAgentLocalRegistryWrite, assertAgentLocalRegistryEffectCurrent, createAgentLocalRegistryWriteLifecycle, createAgentLocalRegistryInputProjector } from './local-registry-admission.js';
import type { Tool, ToolExecuteOptions } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolExecution, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { presentToolAskWith, type ToolAskWords } from '@goodvibes/engine/platform/platform/permissions';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { MemoryRegistry } from '@goodvibes/engine/platform/platform/state';
import type { MemoryAccess } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import { AgentPersonaRegistry, type AgentPersonaRecord } from './persona-registry.js';
import { AgentNoteRegistry, type AgentNoteRecord } from './note-registry.js';
import { AgentRoutineRegistry, type AgentRoutineRecord } from './routine-registry.js';
import { AgentSkillRegistry, type AgentSkillBundleRecord, type AgentSkillRecord } from './skill-registry.js';
import type { DaemonCapabilityAnswer } from './capability-tools.js';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from './record-labels.js';
import { assertActorMayEnable, assertActorMayMarkReviewed } from './review-authority.js';
import { formatRefusal, readRefusal } from '@goodvibes/engine/errors';
import {
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
import { toolErrorText } from './tool-error-text.js';

export type AgentLocalRegistryDomain = 'memory' | 'note' | 'persona' | 'skill' | 'skill_bundle' | 'routine';
export type AgentLocalRegistryAction = 'list' | 'search' | 'get' | 'create' | 'update' | 'enable' | 'disable' | 'review' | 'stale' | 'use' | 'clear_active' | 'start' | 'delete';
export type { AgentLocalRegistryToolArgs } from './local-registry-args.js';

const DOMAINS: readonly AgentLocalRegistryDomain[] = ['memory', 'note', 'persona', 'skill', 'skill_bundle', 'routine'];
const ACTIONS: readonly AgentLocalRegistryAction[] = ['list', 'search', 'get', 'create', 'update', 'enable', 'disable', 'review', 'stale', 'use', 'clear_active', 'start', 'delete'];
/** The domains whose every write is the daemon's capability (run nested), never this process's own. */
const ROUTED_DOMAINS: readonly AgentLocalRegistryDomain[] = ['note', 'persona', 'skill', 'skill_bundle', 'routine'];

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

/** A reason the model gave, or the words that say it gave none (the capability needs one). */
const reasonOf = (args: AgentLocalRegistryToolArgs): string => readString(args.reason) || 'the model gave no reason';

/** Note reads stay in this process (the same file); every write is the daemon's note capability, so every open list follows it. */
async function handleNote(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>, run: SkillCapabilityRun): Promise<string> {
  if (action === 'create') {
    return skillWrite(run, effects, 'notes.create', {
      title: readString(args.title ?? args.name ?? args.summary), body: requireTextField(args.body ?? args.detail ?? args.description, 'body'),
      tags: listInput(args.tags), url: readString(args.sourceUrl),
    }, 'note');
  }
  if (action === 'update') {
    requireUpdateFields('note', { title: args.title ?? args.name ?? args.summary, body: args.body ?? args.detail ?? args.description, tags: args.tags, sourceUrl: args.sourceUrl === undefined ? undefined : true });
    return skillWrite(run, effects, 'notes.edit', {
      note: requireId(args), title: readString(args.title ?? args.name ?? args.summary), body: readString(args.body ?? args.detail ?? args.description),
      tags: listInput(args.tags), url: readString(args.sourceUrl),
    }, 'note');
  }
  if (action === 'review') assertActorMayMarkReviewed('model', 'note', requireId(args));
  if (action === 'stale') return skillWrite(run, effects, 'notes.stale', { note: requireId(args), reason: reasonOf(args) }, 'note');
  if (action === 'delete') return skillWrite(run, effects, 'notes.delete', { note: requireId(args) }, 'note');
  return readNote(shellPaths, action, args, effects);
}

function readNote(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>): string {
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

/** Persona reads stay in this process; every write is the daemon's persona capability, so every open list follows it. */
async function handlePersona(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>, run: SkillCapabilityRun): Promise<string> {
  if (action === 'create') {
    const activate = readActivation(args.activate);
    const made = await skillWrite(run, effects, 'personas.create', {
      name: requireName(args), description: requireDescription(args), body: requireTextField(args.body, 'body'), tags: listInput(args.tags), triggers: listInput(args.triggers),
    }, 'persona');
    const id = made.match(/^ {2}id (.+)$/m)?.[1];
    return activate === true && id ? [made, await skillWrite(run, effects, 'personas.use', { persona: id }, 'persona')].join('\n') : made;
  }
  if (action === 'update') {
    const activate = readActivation(args.activate);
    requireUpdateFields('persona', { name: args.name, description: args.description, body: args.body, tags: args.tags, triggers: args.triggers, activate: activate });
    const id = requireId(args);
    const said: string[] = [];
    if ([args.name, args.description, args.body, args.tags, args.triggers].some((value) => value !== undefined)) {
      said.push(await skillWrite(run, effects, 'personas.update', {
        persona: id, name: readString(args.name), description: readString(args.description), body: readString(args.body), tags: listInput(args.tags), triggers: listInput(args.triggers),
      }, 'persona'));
    }
    if (activate === true) said.push(await skillWrite(run, effects, 'personas.use', { persona: id }, 'persona'));
    // false clears it only when it is the one in use.
    if (activate === false && AgentPersonaRegistry.fromShellPaths(shellPaths, effects).snapshot().activePersonaId === id) said.push(await skillWrite(run, effects, 'personas.stop-using', {}, 'persona'));
    return said.join('\n');
  }
  if (action === 'use') return skillWrite(run, effects, 'personas.use', { persona: requireId(args) }, 'persona');
  if (action === 'clear_active') return skillWrite(run, effects, 'personas.stop-using', {}, 'persona');
  if (action === 'review') {
    assertActorMayMarkReviewed('model', 'persona', requireId(args));
    return skillWrite(run, effects, 'personas.review', { persona: requireId(args) }, 'persona');
  }
  if (action === 'stale') return skillWrite(run, effects, 'personas.stale', { persona: requireId(args), reason: reasonOf(args) }, 'persona');
  if (action === 'delete') return skillWrite(run, effects, 'personas.delete', { persona: requireId(args) }, 'persona');
  return readPersona(shellPaths, action, args, effects);
}

function readPersona(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>): string {
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
  throw new Error(invalidAction(action, 'personas', 'persona'));
}

/** A daemon capability run for this tool call (capability-tools.ts `daemonCapabilityRunner`). */
type SkillCapabilityRun = (id: string, inputs: Readonly<Record<string, string>>) => Promise<DaemonCapabilityAnswer>;

/**
 * A skill or bundle write, made by the daemon's skills capability (the one the Skills tab runs), so every program's
 * list follows it. The call's own checks hold before it is sent, and the store's change is accepted as this call's.
 */
async function skillWrite(run: SkillCapabilityRun, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>, id: string, inputs: Readonly<Record<string, string | undefined>>, kind: 'skill' | 'bundle' | 'note' | 'persona' | 'routine'): Promise<string> {
  effects.assertCurrent();
  const given = Object.fromEntries(Object.entries(inputs).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  const answer = await run(id, given);
  if (!answer.ok) throw new Error(answer.error);
  effects.onEffect();
  const facts = answer.data[kind];
  const recordId = typeof facts === 'string' ? facts : facts !== null && typeof facts === 'object' && typeof (facts as Record<string, unknown>)['id'] === 'string' ? (facts as Record<string, unknown>)['id'] as string : '';
  return [answer.text || `${id}: done.`, ...(recordId ? [`  id ${recordId}`] : [])].join('\n');
}

/** A list argument as a capability's comma-separated input; undefined when it was not given. */
function listInput(value: unknown): string | undefined {
  return value === undefined ? undefined : readStringList(value).join(', ');
}

/** Skill and bundle reads stay in this process (the same files); every write goes through the daemon's capabilities. */
async function handleSkill(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>, run: SkillCapabilityRun): Promise<string> {
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
    return skillWrite(run, effects, 'my-skills.create', {
      name: requireName(args),
      description: requireDescription(args),
      procedure: requireTextField(args.procedure, 'procedure'),
      triggers: listInput(args.triggers),
      tags: listInput(args.tags),
      env: listInput(args.requiresEnv),
      commands: listInput(args.requiresCommands),
      enabled: args.enabled === true ? 'yes' : 'no',
    }, 'skill');
  }
  if (action === 'update') {
    const id = requireId(args);
    // An edit returns the skill to unreviewed, so enabling in the same call needs the owner.
    if (args.enabled === true) assertActorMayEnable('model', 'skill', id, [args.name, args.description, args.procedure, args.triggers, args.tags,
      args.requiresEnv, args.requiresCommands].some((value) => value !== undefined) ? 'fresh' : registry.get(id)?.reviewState);
    requireUpdateFields('skill', { name: args.name, description: args.description, procedure: args.procedure, triggers: args.triggers, tags: args.tags,
      requiresEnv: args.requiresEnv, requiresCommands: args.requiresCommands, enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined });
    const fieldsGiven = [args.name, args.description, args.procedure, args.triggers, args.tags, args.requiresEnv, args.requiresCommands].some((value) => value !== undefined);
    const lines: string[] = [];
    if (fieldsGiven) {
      lines.push(await skillWrite(run, effects, 'my-skills.update', {
        skill: id,
        name: readString(args.name) || undefined,
        description: readString(args.description) || undefined,
        procedure: readString(args.procedure) || undefined,
        triggers: listInput(args.triggers),
        tags: listInput(args.tags),
        env: listInput(args.requiresEnv),
        commands: listInput(args.requiresCommands),
      }, 'skill'));
    }
    if (typeof args.enabled === 'boolean') lines.push(await skillWrite(run, effects, args.enabled ? 'my-skills.enable' : 'my-skills.disable', { skill: id }, 'skill'));
    return lines.join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    if (action === 'enable') assertActorMayEnable('model', 'skill', requireId(args), registry.get(requireId(args))?.reviewState);
    return skillWrite(run, effects, action === 'enable' ? 'my-skills.enable' : 'my-skills.disable', { skill: requireId(args) }, 'skill');
  }
  if (action === 'review') {
    // The owner's own act: refused here with what the owner does instead (nothing is sent).
    assertActorMayMarkReviewed('model', 'skill', requireId(args));
    return skillWrite(run, effects, 'my-skills.review', { skill: requireId(args) }, 'skill');
  }
  if (action === 'stale') {
    return skillWrite(run, effects, 'my-skills.stale', { skill: requireId(args), reason: readString(args.reason) || 'marked out of date by the Agent' }, 'skill');
  }
  if (action === 'delete') {
    return skillWrite(run, effects, 'my-skills.delete', { skill: requireId(args) }, 'skill');
  }
  throw new Error(invalidAction(action, 'skills', 'skill'));
}

async function handleSkillBundle(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>, run: SkillCapabilityRun): Promise<string> {
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
    return skillWrite(run, effects, 'my-skills.bundle-create', {
      name: requireName(args),
      description: requireDescription(args),
      skills: readStringList(args.skillIds ?? args.skills).join(', '),
      enabled: args.enabled === true ? 'yes' : 'no',
    }, 'bundle');
  }
  if (action === 'update') {
    const id = requireId(args);
    if (args.enabled === true) assertActorMayEnable('model', 'skill bundle', id,
      [args.name, args.description, args.skillIds, args.skills].some((value) => value !== undefined) ? 'fresh' : registry.getBundle(id)?.reviewState);
    requireUpdateFields('skill bundle', { name: args.name, description: args.description, skillIds: args.skillIds ?? args.skills, enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined });
    const fieldsGiven = [args.name, args.description, args.skillIds, args.skills].some((value) => value !== undefined);
    const lines: string[] = [];
    if (fieldsGiven) {
      lines.push(await skillWrite(run, effects, 'my-skills.bundle-update', {
        bundle: id,
        name: readString(args.name) || undefined,
        description: readString(args.description) || undefined,
        skills: args.skillIds === undefined && args.skills === undefined ? undefined : readStringList(args.skillIds ?? args.skills).join(', '),
      }, 'bundle'));
    }
    if (typeof args.enabled === 'boolean') lines.push(await skillWrite(run, effects, args.enabled ? 'my-skills.bundle-enable' : 'my-skills.bundle-disable', { bundle: id }, 'bundle'));
    return lines.join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    if (action === 'enable') assertActorMayEnable('model', 'skill bundle', requireId(args), registry.getBundle(requireId(args))?.reviewState);
    return skillWrite(run, effects, action === 'enable' ? 'my-skills.bundle-enable' : 'my-skills.bundle-disable', { bundle: requireId(args) }, 'bundle');
  }
  if (action === 'review') {
    assertActorMayMarkReviewed('model', 'skill bundle', requireId(args));
    return skillWrite(run, effects, 'my-skills.bundle-review', { bundle: requireId(args) }, 'bundle');
  }
  if (action === 'stale') {
    return skillWrite(run, effects, 'my-skills.bundle-stale', { bundle: requireId(args), reason: readString(args.reason) || 'marked out of date by the Agent' }, 'bundle');
  }
  if (action === 'delete') {
    return skillWrite(run, effects, 'my-skills.bundle-delete', { bundle: requireId(args) }, 'bundle');
  }
  throw new Error(invalidAction(action, 'skill bundles', 'skill_bundle'));
}

/** Routine reads stay in this process; every write (a start's count too) is the daemon's routine capability. */
async function handleRoutine(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>, run: SkillCapabilityRun): Promise<string> {
  const requirements = { env: listInput(args.requiresEnv), commands: listInput(args.requiresCommands) };
  if (action === 'create') {
    if (args.enabled === true) assertActorMayEnable('model', 'routine', requireName(args), 'fresh');
    return skillWrite(run, effects, 'routines.create', {
      name: requireName(args), description: requireDescription(args), steps: requireTextField(args.steps, 'steps'),
      triggers: listInput(args.triggers), tags: listInput(args.tags), ...requirements, enabled: args.enabled === true ? 'yes' : 'no',
    }, 'routine');
  }
  if (action === 'update') {
    const id = requireId(args);
    const fieldsGiven = [args.name, args.description, args.steps, args.triggers, args.tags, args.requiresEnv, args.requiresCommands].some((value) => value !== undefined);
    if (args.enabled === true) assertActorMayEnable('model', 'routine', id, fieldsGiven ? 'fresh' : AgentRoutineRegistry.fromShellPaths(shellPaths, effects).get(id)?.reviewState);
    requireUpdateFields('routine', { name: args.name, description: args.description, steps: args.steps, triggers: args.triggers, tags: args.tags,
      requiresEnv: args.requiresEnv, requiresCommands: args.requiresCommands, enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined });
    const said: string[] = [];
    if (fieldsGiven) {
      said.push(await skillWrite(run, effects, 'routines.update', {
        routine: id, name: readString(args.name), description: readString(args.description), steps: readString(args.steps),
        triggers: listInput(args.triggers), tags: listInput(args.tags), ...requirements,
      }, 'routine'));
    }
    if (typeof args.enabled === 'boolean') said.push(await skillWrite(run, effects, args.enabled ? 'routines.enable' : 'routines.disable', { routine: id }, 'routine'));
    return said.join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    if (action === 'enable') assertActorMayEnable('model', 'routine', requireId(args), AgentRoutineRegistry.fromShellPaths(shellPaths, effects).get(requireId(args))?.reviewState);
    return skillWrite(run, effects, action === 'enable' ? 'routines.enable' : 'routines.disable', { routine: requireId(args) }, 'routine');
  }
  if (action === 'start') {
    effects.assertCurrent();
    const answer = await run('routines.count-start', { routine: requireId(args) });
    if (!answer.ok) throw new Error(answer.error);
    effects.onEffect();
    const started = answer.data['routine'] as { readonly id?: string; readonly name?: string; readonly steps?: string } | undefined;
    return [
      'Started Agent-local routine',
      `  id ${started?.id ?? requireId(args)}`,
      `  name ${started?.name ?? ''}`,
      'Policy: same main conversation; no hidden background job, connected-host mutation, or external side effect was started.',
      '',
      started?.steps ?? '',
    ].join('\n');
  }
  if (action === 'review') {
    assertActorMayMarkReviewed('model', 'routine', requireId(args));
    return skillWrite(run, effects, 'routines.review', { routine: requireId(args) }, 'routine');
  }
  if (action === 'stale') return skillWrite(run, effects, 'routines.stale', { routine: requireId(args), reason: reasonOf(args) }, 'routine');
  if (action === 'delete') return skillWrite(run, effects, 'routines.delete', { routine: requireId(args) }, 'routine');
  return readRoutine(shellPaths, action, args, effects);
}

function readRoutine(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs, effects: ReturnType<typeof createAgentLocalRegistryWriteLifecycle>): string {
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
  throw new Error(invalidAction(action, 'routines', 'routine'));
}

/**
 * How the tool runs a daemon capability (capability-tools.ts `daemonCapabilityRunner`): every write goes there, as a
 * nested `capability_run` call of this tool call, judged by that capability's own risk (a delete that cannot be undone
 * is asked as capability_run asks it).
 */
export type AgentLocalRegistryCapabilityRun = (id: string, inputs: Readonly<Record<string, string>>, options?: ToolExecuteOptions) => Promise<DaemonCapabilityAnswer>;

export function createAgentLocalRegistryTool(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, memorySpine: MemoryAccess, runCapability: AgentLocalRegistryCapabilityRun): Tool {
  return {
    definition: {
      name: 'agent_local_registry',
      activity: {
        doing: 'Checking', did: 'checked', object: 'Agent records',
        byAction: {
          change: { doing: 'Updating', did: 'updated', object: 'Agent records' },
          run: { doing: 'Using', did: 'used', object: 'Agent records' },
          delete: { doing: 'Deleting from', did: 'deleted from', object: 'Agent records' },
        },
      },
      description: 'Inspect or update Agent-local records by domain. Actions per domain: memory, note: list, search, get, create, update, review, stale, delete. persona adds use and clear_active. skill and skill_bundle add enable and disable. routine adds enable, disable and start. Create needs: memory summary; note title and body; persona name, description and body; skill name, description and procedure; skill_bundle name, description and skillIds; routine name, description and steps. Writes need current recorded admission. Marking a memory record, note, persona, skill, skill bundle or routine reviewed, and enabling one nobody reviewed, are the owner\'s: refused here with the command the owner types.',
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
          confidence: { type: 'number', description: 'Confidence from 0 to 100 for a memory record being created; changing it later is part of the owner\'s review.' },
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
      // Every call outside the memory domain reads in this process or routes one daemon capability, which runs as a
      // nested capability_run call judged by its own risk: this call is classed a read, so the capability's question is
      // the only one. A memory write is this process's own and is decided as itself.
      readModes: { field: 'domain', values: ROUTED_DOMAINS },
    },
    execute: async (rawArgs, options) => {
      const args: AgentLocalRegistryToolArgs = rawArgs;
      if (!isDomain(args.domain)) return registryError(`Unknown domain. Valid values ${DOMAINS.join(', ')}.`);
      if (!isAction(args.action)) return registryError(`Unknown action. Valid values ${ACTIONS.join(', ')}.`);
      const action = args.action;
      try {
        options?.signal?.throwIfAborted(); assertCurrentToolExecution(rawArgs, options);
        // A routed write is the nested capability_run call's to decide and admit: this call only holds its own currency.
        const routed = args.domain !== 'memory';
        if (!['list', 'search', 'get'].includes(args.action)) assertAgentLocalRegistryWrite(rawArgs, options, routed);
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
        const effects = createAgentLocalRegistryWriteLifecycle(rawArgs, options, routed);
        // Every write is the daemon's capability (the one the place runs), so every program's open list follows it.
        const run: SkillCapabilityRun = (id, inputs) => runCapability(id, inputs, options);
        if (args.domain === 'note') return registryOutput(await handleNote(shellPaths, args.action, args, effects, run));
        if (args.domain === 'persona') return registryOutput(await handlePersona(shellPaths, args.action, args, effects, run));
        if (args.domain === 'skill') return registryOutput(await handleSkill(shellPaths, args.action, args, effects, run));
        if (args.domain === 'skill_bundle') return registryOutput(await handleSkillBundle(shellPaths, args.action, args, effects, run));
        return registryOutput(await handleRoutine(shellPaths, args.action, args, effects, run));
      } catch (error) {
        // An admission problem or a cancelled call is rethrown for the tool runtime to report.
        const text = toolErrorText(error, options?.signal);
        const refused = readRefusal(error);
        return registryError(refused ? formatRefusal(refused) : text);
      }
    },
  };
}

/** What one record of each domain is called, as a person says it. */
const DOMAIN_NOUNS: Readonly<Record<AgentLocalRegistryDomain, { readonly one: string; readonly many: string }>> = {
  memory: { one: 'a memory', many: 'your memories' },
  note: { one: 'a note', many: 'your notes' },
  persona: { one: 'a persona', many: 'your personas' },
  skill: { one: 'a skill', many: 'your skills' },
  skill_bundle: { one: 'a skill bundle', many: 'your skill bundles' },
  routine: { one: 'a routine', many: 'your routines' },
};

/** A record's own title as the call names it, for the question's subject. */
function namedRecord(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const field of ['summary', 'title', 'name', 'id']) {
    const value = args[field];
    if (typeof value === 'string' && value.trim()) return value.trim().length > 60 ? `${value.trim().slice(0, 59)}…` : value.trim();
  }
  return undefined;
}

/**
 * The question for one call, in the words of the act on its own domain ("Remember this: …?", "Delete a note?"),
 * never one sentence for every kind of record. A routed domain's write is asked by its capability (capability_run);
 * these words are what that call says where it is named (a held or refused call, a remembered answer).
 */
export function agentLocalRegistryAskWords(args: Readonly<Record<string, unknown>>): ToolAskWords | undefined {
  const domain = args.domain, action = args.action;
  if (!isDomain(domain) || !isAction(action)) return undefined;
  const { one, many } = DOMAIN_NOUNS[domain];
  const named = namedRecord(args);
  const it = named ? `${one.replace(/^an? /, '')} "${named}"` : one;
  const words: Record<AgentLocalRegistryAction, readonly [question: string, doing: string]> = {
    list: [`Look through ${many}?`, `Looking through ${many}`],
    search: [`Search ${many}?`, `Searching ${many}`],
    get: [`Read ${it}?`, `Reading ${it}`],
    create: domain === 'memory'
      ? [named ? `Remember this: "${named}"?` : 'Remember something?', 'Remembering it']
      : [`Add ${it}?`, `Adding ${it}`],
    update: [`Change ${it}?`, `Changing ${it}`],
    enable: [`Turn on ${it}?`, `Turning on ${it}`],
    disable: [`Turn off ${it}?`, `Turning off ${it}`],
    review: [`Mark ${it} reviewed?`, `Marking ${it} reviewed`],
    stale: [`Mark ${it} out of date?`, `Marking ${it} out of date`],
    use: [`Use ${it} from now on?`, `Using ${it}`],
    clear_active: ['Stop using the active persona?', 'Stopping the active persona'],
    start: [`Start ${it}?`, `Starting ${it}`],
    delete: domain === 'memory' ? [`Forget ${it}?`, `Forgetting ${it}`] : [`Delete ${it}?`, `Deleting ${it}`],
  };
  const [question, doing] = words[action];
  return { question, lines: [], subject: question.replace(/\?$/, ''), doing };
}

export function registerAgentLocalRegistryTool(registry: ToolRegistry, shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, memorySpine: MemoryAccess, runCapability: AgentLocalRegistryCapabilityRun): void {
  // Each call is asked in the words of its own act on its own kind of record (the last registration is used).
  presentToolAskWith('agent_local_registry', agentLocalRegistryAskWords);
  registry.register(createAgentLocalRegistryTool(shellPaths, memoryRegistry, memorySpine, runCapability),
    { inputProjection: createAgentLocalRegistryInputProjector(shellPaths, memoryRegistry, memorySpine) });
}

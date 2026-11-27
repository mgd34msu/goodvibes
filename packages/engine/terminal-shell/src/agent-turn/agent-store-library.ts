/**
 * The acts on your personas, VIBE.md files and routines
 * (capabilities/builtin/personas.ts, routines.ts), done by the daemon on the
 * stores every Agent turn reads for its prompt:
 * `~/.goodvibes/agent/personas/personas.json`, the VIBE.md files, and
 * `~/.goodvibes/agent/routines/routines.json`.
 */
import { CapabilityRefusal } from '@goodvibes/engine/platform/platform/capabilities';
import { AgentPersonaRegistry, type AgentPersonaRecord } from './persona-registry.js';
import { AgentRoutineRegistry, evaluateAgentRoutineReadiness, type AgentRoutineRecord } from './routine-registry.js';
import { buildAgentSkillRequirements, formatAgentSkillRequirement } from './skill-registry.js';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from './record-labels.js';
import { discoverVibeFiles, formatVibeStatus, initVibeFile, loadVibeImportSource } from './vibe-file.js';
import { discoverPersonas, discoverRoutines, type DiscoveredPersonaRecord, type DiscoveredRoutineRecord } from './record-discovery.js';
import { ownersOwnReview, provenanceBy, recordLookupValues, splitWords, storeStep, writtenBy, type StoreAct, type StoreActContext } from './agent-store-common.js';

const personasOf = (context: StoreActContext): AgentPersonaRegistry => AgentPersonaRegistry.fromShellPaths(context.shellPaths);
const routinesOf = (context: StoreActContext): AgentRoutineRegistry => AgentRoutineRegistry.fromShellPaths(context.shellPaths);

function frontmatterList(frontmatter: Readonly<Record<string, string>>, keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const values = splitWords(frontmatter[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function findFile<Record extends { readonly name: string; readonly path: string }>(records: readonly Record[], idOrName: string): Record | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return records.find((record) => recordLookupValues(record.name, record.path).includes(lookup)) ?? null;
}

// --- Personas -------------------------------------------------------------

function personaFacts(persona: AgentPersonaRecord, activeId: string | null) {
  return {
    id: persona.id, name: persona.name, description: persona.description, state: persona.id === activeId ? 'in-use' : persona.reviewState,
    review: formatAgentRecordReviewState(persona.reviewState), reviewState: persona.reviewState, inUse: persona.id === activeId, body: persona.body,
    tags: [...persona.tags], triggers: [...persona.triggers], origin: formatAgentRecordOrigin(persona.source, persona.provenance),
    ...(persona.staleReason ? { staleReason: persona.staleReason } : {}), createdAt: persona.createdAt, updatedAt: persona.updatedAt,
  };
}

function renderPersona(persona: AgentPersonaRecord, activeId: string | null): string {
  return [
    `Persona ${persona.name}`,
    `  id ${persona.id}`,
    `  in use: ${persona.id === activeId ? 'yes' : 'no'}`,
    `  review: ${formatAgentRecordReviewState(persona.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(persona.source, persona.provenance)}`,
    `  tags: ${persona.tags.join(', ') || '(none)'}`,
    `  triggers: ${persona.triggers.join(', ') || '(none)'}`,
    `  created: ${persona.createdAt}`,
    `  updated: ${persona.updatedAt}`,
    persona.staleReason ? `  out of date because: ${persona.staleReason}` : '',
    '', persona.description, '', persona.body,
  ].filter(Boolean).join('\n');
}

function personaList(title: string, store: AgentPersonaRegistry, personas: readonly AgentPersonaRecord[]) {
  const snapshot = store.snapshot();
  const rows = personas.map((persona) => {
    const tags = persona.tags.length > 0 ? ` tags ${persona.tags.join(', ')}` : '';
    return `  ${persona.id}  ${persona.id === snapshot.activePersonaId ? 'in use' : 'not in use'}  ${formatAgentRecordReviewState(persona.reviewState)}  ${persona.name} - ${persona.description}${tags}`;
  });
  return {
    text: personas.length === 0 ? `${title}\n  No personas yet.` : [`${title} (${personas.length})`, `  in use ${snapshot.activePersona?.name ?? '(none)'}`, ...rows].join('\n'),
    data: { personas: personas.map((persona) => personaFacts(persona, snapshot.activePersonaId)), active: snapshot.activePersonaId },
  };
}

function personaChange(title: string, persona: AgentPersonaRecord, store: AgentPersonaRegistry, extra = '') {
  const activeId = store.snapshot().activePersonaId;
  return { text: `${title} ${persona.name}${persona.id === activeId ? ' (in use)' : ''}${extra}.`, data: { persona: personaFacts(persona, activeId) } };
}

function personaOrRefuse(store: AgentPersonaRegistry, idOrName: string): AgentPersonaRecord {
  const persona = storeStep(() => store.get(idOrName));
  if (!persona) throw new CapabilityRefusal(`No persona ${idOrName}.`, 'Your personas are listed in Memory and knowledge.', 'NOT_FOUND');
  return persona;
}

function fileFacts(record: DiscoveredPersonaRecord | DiscoveredRoutineRecord) {
  return { id: record.name, name: record.name, description: record.description, path: record.path, origin: record.origin, state: record.origin };
}

function filesText(title: string, records: readonly (DiscoveredPersonaRecord | DiscoveredRoutineRecord)[], kind: 'persona' | 'routine'): string {
  if (records.length === 0) {
    return [title, `  No ${kind} Markdown files found in this project's or your own ${kind} folders.`,
      `  Looked in: .goodvibes/${kind}s, .goodvibes/agent/${kind}s, ~/.goodvibes/${kind}s, ~/.goodvibes/agent/${kind}s`].join('\n');
  }
  return [`${title} (${records.length})`, ...records.map((record) => `  ${record.name}  ${record.origin}${record.description ? ` - ${record.description}` : ''}\n    path ${record.path}`)].join('\n');
}

export const PERSONA_ACTS: Readonly<Record<string, StoreAct>> = {
  async 'personas.list'(_values, context) { const store = personasOf(context); return personaList('Personas', store, storeStep(() => store.list())); },
  async 'personas.active'(_values, context) {
    const snapshot = storeStep(() => personasOf(context).snapshot());
    return snapshot.activePersona
      ? { text: renderPersona(snapshot.activePersona, snapshot.activePersonaId), data: { persona: personaFacts(snapshot.activePersona, snapshot.activePersonaId) } }
      : { text: 'No persona is in use.', data: { persona: null } };
  },
  async 'personas.show'(values, context) {
    const store = personasOf(context);
    const persona = personaOrRefuse(store, values.persona!);
    const activeId = store.snapshot().activePersonaId;
    return { text: renderPersona(persona, activeId), data: { persona: personaFacts(persona, activeId) } };
  },
  async 'personas.search'(values, context) { const store = personasOf(context); return personaList(`Personas matching "${values.words}"`, store, storeStep(() => store.search(values.words!))); },
  async 'personas.create'(values, context) {
    const store = personasOf(context);
    const persona = storeStep(() => store.create({
      name: values.name!, description: values.description!, body: values.body!, tags: splitWords(values.tags), triggers: splitWords(values.triggers), source: 'user', provenance: provenanceBy(context, 'Command'), author: writtenBy(context),
    }));
    return personaChange('Made persona', persona, store);
  },
  async 'personas.update'(values, context) {
    const store = personasOf(context);
    const persona = storeStep(() => store.update(values.persona!, {
      name: values.name || undefined, description: values.description || undefined, body: values.body || undefined,
      tags: values.tags ? splitWords(values.tags) : undefined, triggers: values.triggers ? splitWords(values.triggers) : undefined, provenance: provenanceBy(context, 'Command'), by: writtenBy(context),
    }));
    return personaChange('Changed persona', persona, store);
  },
  async 'personas.use'(values, context) { const store = personasOf(context); return personaChange('Using persona', storeStep(() => store.setActive(values.persona!)), store); },
  async 'personas.stop-using'(_values, context) { storeStep(() => personasOf(context).clearActive()); return { text: 'No persona is in use now.', data: { active: null } }; },
  async 'personas.review'(values, context) { ownersOwnReview(context, 'Marking a persona reviewed'); const store = personasOf(context); return personaChange('Reviewed persona', storeStep(() => store.markReviewed(values.persona!, { accept: true })), store); },
  async 'personas.stale'(values, context) { const store = personasOf(context); return personaChange('Marked out of date', storeStep(() => store.markStale(values.persona!, values.reason!)), store); },
  async 'personas.delete'(values, context) { const store = personasOf(context); return personaChange('Deleted persona', storeStep(() => store.deletePersona(values.persona!)), store); },
  async 'personas.discover'(_values, context) {
    const found = await discoverPersonas(context.shellPaths);
    return { text: filesText('Persona files you could import', found, 'persona'), data: { files: found.map(fileFacts) } };
  },
  async 'personas.import'(values, context) {
    const discovered = findFile(await discoverPersonas(context.shellPaths), values.file!);
    if (!discovered) throw new CapabilityRefusal(`No persona file ${values.file}.`, 'The persona files found are listed in Memory and knowledge.', 'NOT_FOUND');
    const store = personasOf(context);
    const persona = storeStep(() => store.create({
      name: discovered.name, description: discovered.description || `Imported persona from ${discovered.origin} markdown file.`, body: discovered.body,
      tags: frontmatterList(discovered.frontmatter, ['tags']), triggers: frontmatterList(discovered.frontmatter, ['triggers']),
      source: 'imported', provenance: provenanceBy(context, `Imported file (${discovered.origin}): ${discovered.path}`), author: writtenBy(context),
    }));
    if (values.use === 'yes') storeStep(() => store.setActive(persona.id));
    return personaChange('Imported persona', persona, store, values.use === 'yes' ? '' : '; not in use yet');
  },
  async 'personas.vibe'(_values, context) {
    const snapshot = storeStep(() => discoverVibeFiles(context.shellPaths));
    return { text: formatVibeStatus(snapshot), data: { files: snapshot.files.map((file) => ({ path: file.path, scope: file.scope })) } };
  },
  async 'personas.vibe-show'(values, context) {
    const source = storeStep(() => loadVibeImportSource(context.shellPaths, values.where || 'project'));
    return {
      text: [`${source.scope === 'global' ? 'Your own' : 'This project\'s'} VIBE.md`, `  path ${source.path}`, `  name ${source.name}`, `  description ${source.description}`, '', source.body].join('\n'),
      data: { path: source.path, scope: source.scope, name: source.name },
    };
  },
  async 'personas.vibe-create'(values, context) {
    const scope = values.where === 'global' ? 'global' : 'project';
    const result = storeStep(() => initVibeFile(context.shellPaths, { scope, force: values.replace === 'yes' }));
    if (!result.created) throw new CapabilityRefusal(`A VIBE.md is already at ${result.path}; nothing was written.`, 'Choose "Put the starter in its place" to write over it.');
    return { text: `Wrote a starter VIBE.md at ${result.path}; fill it in, then use it as a persona.`, data: { path: result.path, scope } };
  },
  async 'personas.vibe-import'(values, context) {
    if (values.review === 'yes') ownersOwnReview(context, 'Marking a persona reviewed');
    const source = storeStep(() => loadVibeImportSource(context.shellPaths, values.where || 'project'));
    const store = personasOf(context);
    const persona = storeStep(() => store.create({
      name: values.name || source.name, description: values.description || source.description, body: source.body,
      tags: ['vibe', source.scope], triggers: ['vibe'], source: 'imported', provenance: provenanceBy(context, `Imported VIBE.md (${source.scope}): ${source.path}`), author: writtenBy(context),
    }));
    if (values.review === 'yes') storeStep(() => store.markReviewed(persona.id, { accept: true }));
    if (values.use === 'yes') storeStep(() => store.setActive(persona.id));
    return {
      text: [`Made persona ${persona.id} (${persona.name}) from ${source.path}`, `  reviewed ${values.review === 'yes' ? 'yes' : 'no'}`, `  in use ${values.use === 'yes' ? 'yes' : 'no'}`].join('\n'),
      data: { persona: persona.id, path: source.path },
    };
  },
};

// --- Routines -------------------------------------------------------------

function readinessOf(routine: AgentRoutineRecord): string {
  const readiness = evaluateAgentRoutineReadiness(routine);
  return readiness.ready ? 'ready' : `needs ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}`;
}

function routineFacts(routine: AgentRoutineRecord) {
  const readiness = evaluateAgentRoutineReadiness(routine);
  return {
    id: routine.id, name: routine.name, description: routine.description,
    state: !readiness.ready ? 'needs-setup' : routine.enabled ? 'on' : 'off', enabled: routine.enabled, ready: readiness.ready, readiness: readinessOf(routine),
    review: formatAgentRecordReviewState(routine.reviewState), reviewState: routine.reviewState, steps: routine.steps,
    requirements: routine.requirements.map(formatAgentSkillRequirement), tags: [...routine.tags], triggers: [...routine.triggers],
    origin: formatAgentRecordOrigin(routine.source, routine.provenance), startCount: routine.startCount,
    ...(routine.lastStartedAt ? { lastStartedAt: routine.lastStartedAt } : {}), ...(routine.staleReason ? { staleReason: routine.staleReason } : {}),
    createdAt: routine.createdAt, updatedAt: routine.updatedAt,
  };
}

function renderRoutine(routine: AgentRoutineRecord): string {
  return [
    `Routine ${routine.name}`,
    `  id ${routine.id}`,
    `  switched on: ${routine.enabled ? 'yes' : 'no'}`,
    `  readiness: ${readinessOf(routine)}`,
    `  needs: ${routine.requirements.map(formatAgentSkillRequirement).join(', ') || '(nothing)'}`,
    `  review: ${formatAgentRecordReviewState(routine.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(routine.source, routine.provenance)}`,
    `  tags: ${routine.tags.join(', ') || '(none)'}`,
    `  triggers: ${routine.triggers.join(', ') || '(when you ask)'}`,
    `  started ${routine.startCount}${routine.lastStartedAt ? `; last ${routine.lastStartedAt}` : ''}`,
    `  created ${routine.createdAt}`,
    `  updated ${routine.updatedAt}`,
    routine.staleReason ? `  out of date because: ${routine.staleReason}` : '',
    '', routine.description, '', routine.steps,
  ].filter(Boolean).join('\n');
}

function routineList(title: string, store: AgentRoutineRegistry, routines: readonly AgentRoutineRecord[], empty = 'No routines yet.') {
  const snapshot = store.snapshot();
  const rows = routines.map((routine) => {
    const tags = routine.tags.length > 0 ? ` tags ${routine.tags.join(', ')}` : '';
    return `  ${routine.id}  ${routine.enabled ? 'on' : 'off'}  ${formatAgentRecordReviewState(routine.reviewState)}  ${readinessOf(routine)}  started ${routine.startCount}  ${routine.name} - ${routine.description}${tags}`;
  });
  return {
    text: routines.length === 0 ? `${title}\n  ${empty}` : [`${title} (${routines.length})`, `  switched on ${snapshot.enabledRoutines.length}`, ...rows].join('\n'),
    data: { routines: routines.map(routineFacts) },
  };
}

function routineChange(title: string, routine: AgentRoutineRecord) {
  return { text: `${title} ${routine.name}${routine.enabled ? ' (switched on)' : ''}.`, data: { routine: routineFacts(routine) } };
}

function routineOrRefuse(store: AgentRoutineRegistry, idOrName: string): AgentRoutineRecord {
  const routine = storeStep(() => store.get(idOrName));
  if (!routine) throw new CapabilityRefusal(`No routine ${idOrName}.`, 'Your routines are listed in Memory and knowledge.', 'NOT_FOUND');
  return routine;
}

export const ROUTINE_ACTS: Readonly<Record<string, StoreAct>> = {
  async 'routines.count-start'(values, context) {
    const started = startRoutine(context.shellPaths, values.routine!);
    return { text: `Counted routine ${started.name} as started.`, data: { routine: started } };
  },
  async 'routines.list'(values, context) {
    const store = routinesOf(context);
    if (values.only === 'enabled') return routineList('Routines switched on', store, storeStep(() => store.snapshot().enabledRoutines));
    if (values.only === 'attention') return routineList('Routines needing setup', store, storeStep(() => store.list()).filter((routine) => !evaluateAgentRoutineReadiness(routine).ready), 'No routine needs setup.');
    return routineList('Routines', store, storeStep(() => store.list()));
  },
  async 'routines.show'(values, context) { const routine = routineOrRefuse(routinesOf(context), values.routine!); return { text: renderRoutine(routine), data: { routine: routineFacts(routine) } }; },
  async 'routines.search'(values, context) { const store = routinesOf(context); return routineList(`Routines matching "${values.words}"`, store, storeStep(() => store.search(values.words!))); },
  async 'routines.create'(values, context) {
    const routine = storeStep(() => routinesOf(context).create({
      name: values.name!, description: values.description!, steps: values.steps!, triggers: splitWords(values.triggers), tags: splitWords(values.tags),
      requirements: buildAgentSkillRequirements({ env: splitWords(values.env), commands: splitWords(values.commands) }),
      enabled: values.enabled === 'yes', source: 'user', provenance: provenanceBy(context, 'Command'), author: writtenBy(context),
    }));
    return routineChange('Made routine', routine);
  },
  async 'routines.update'(values, context) {
    const store = routinesOf(context);
    const existing = storeStep(() => store.get(values.routine!));
    // A kind of requirement not given keeps what the routine already requires of that kind.
    const kept = (kind: 'env' | 'command'): readonly string[] => (existing?.requirements ?? []).filter((requirement) => requirement.kind === kind).map((requirement) => requirement.name);
    const routine = storeStep(() => store.update(values.routine!, {
      name: values.name || undefined, description: values.description || undefined, steps: values.steps || undefined,
      triggers: values.triggers ? splitWords(values.triggers) : undefined, tags: values.tags ? splitWords(values.tags) : undefined,
      requirements: values.env || values.commands
        ? buildAgentSkillRequirements({ env: values.env ? splitWords(values.env) : kept('env'), commands: values.commands ? splitWords(values.commands) : kept('command') })
        : undefined,
      provenance: provenanceBy(context, 'Command'), by: writtenBy(context),
    }));
    return routineChange('Changed routine', routine);
  },
  async 'routines.review'(values, context) { ownersOwnReview(context, 'Marking a routine reviewed'); return routineChange('Reviewed routine', storeStep(() => routinesOf(context).markReviewed(values.routine!, { accept: true }))); },
  async 'routines.stale'(values, context) { return routineChange('Marked out of date', storeStep(() => routinesOf(context).markStale(values.routine!, values.reason!))); },
  async 'routines.delete'(values, context) { return routineChange('Deleted routine', storeStep(() => routinesOf(context).deleteRoutine(values.routine!))); },
  async 'routines.discover'(_values, context) {
    const found = await discoverRoutines(context.shellPaths);
    return { text: filesText('Routine files you could import', found, 'routine'), data: { files: found.map(fileFacts) } };
  },
  async 'routines.import'(values, context) {
    const discovered = findFile(await discoverRoutines(context.shellPaths), values.file!);
    if (!discovered) throw new CapabilityRefusal(`No routine file ${values.file}.`, 'The routine files found are listed in Memory and knowledge.', 'NOT_FOUND');
    const routine = storeStep(() => routinesOf(context).create({
      name: discovered.name, description: discovered.description || `Imported routine from ${discovered.origin} markdown file.`, steps: discovered.steps,
      tags: frontmatterList(discovered.frontmatter, ['tags']), triggers: frontmatterList(discovered.frontmatter, ['triggers']),
      requirements: buildAgentSkillRequirements({
        env: frontmatterList(discovered.frontmatter, ['requiresEnv', 'requires-env', 'requires_env']),
        commands: frontmatterList(discovered.frontmatter, ['requiresCommands', 'requires-commands', 'requires_commands', 'commands']),
      }),
      enabled: values.enabled === 'yes', source: 'imported', provenance: provenanceBy(context, `discovered:${discovered.origin}:${discovered.path}`), author: writtenBy(context),
    }));
    return routineChange('Imported routine', routine);
  },
};

/** A routine marked started, for the conversation that sends its steps (builtin/routines.ts ROUTINES_START). */
export function startRoutine(shellPaths: StoreActContext['shellPaths'], idOrName: string): { readonly id: string; readonly name: string; readonly steps: string; readonly readiness: string } {
  const store = AgentRoutineRegistry.fromShellPaths(shellPaths);
  const found = routineOrRefuse(store, idOrName);
  const routine = storeStep(() => store.markStarted(found.id));
  return { id: routine.id, name: routine.name, steps: routine.steps, readiness: readinessOf(routine) };
}

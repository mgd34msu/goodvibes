import { existsSync, readFileSync } from 'node:fs';
import { AgentSkillRegistry, buildAgentSkillRequirements, evaluateAgentSkillBundleReadiness, evaluateAgentSkillReadiness, formatAgentSkillRequirement } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-registry';
import { type AgentSkillBundleRecord, type AgentSkillRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-registry-types';
import { discoverSkills, type SkillRecord } from '../../agent/skill-discovery.ts';
import { parseSkillStandardMarkdown, skillStandardFilePath } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-standard';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '@goodvibes-jev/engine/terminal-shell/agent-turn/record-labels';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { resolveCommandFilePath } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';
import { assertActorMayEnable, assertActorMayMarkReviewed, type RegistryActor } from '@goodvibes-jev/engine/terminal-shell/agent-turn/review-authority';
import { commandRefusal } from './confirmation.ts';
import { defineCommand, defineList, type ActionDescription, type ActionValues, type InputDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';

function splitList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function existingRequirementNames(registry: AgentSkillRegistry, id: string, kind: 'env' | 'command'): readonly string[] {
  return (registry.get(id)?.requirements ?? []).filter((requirement) => requirement.kind === kind).map((requirement) => requirement.name);
}

/** Who this command acts for: the model when it ran the command, the owner otherwise. */
function actorOf(ctx: CommandContext): RegistryActor {
  return ctx.invokedByModel === true ? 'model' : 'owner';
}

function registryFromContext(ctx: CommandContext): AgentSkillRegistry {
  return AgentSkillRegistry.fromShellPaths(requireShellPaths(ctx));
}

function formatSkillReceipt(title: string, record: { readonly id: string; readonly name: string }, extra: readonly string[] = []): string {
  return [
    `${title} ${record.id}`,
    `  id ${record.id}`,
    `  name ${record.name}`,
    ...extra,
  ].join('\n');
}

function summarizeSkill(skill: AgentSkillRecord): string {
  const enabled = skill.enabled ? 'enabled' : 'disabled';
  const tags = skill.tags.length > 0 ? ` tags ${skill.tags.join(', ')}` : '';
  const readiness = evaluateAgentSkillReadiness(skill);
  const review = formatAgentRecordReviewState(skill.reviewState);
  const ready = readiness.ready ? 'ready' : `needs ${readiness.missing.map(formatAgentSkillRequirement).join(',')}`;
  return `  ${skill.id}  ${enabled}  ${review}  ${ready}  ${skill.name} - ${skill.description}${tags}`;
}

function summarizeBundle(bundle: AgentSkillBundleRecord, skills: readonly AgentSkillRecord[]): string {
  const enabled = bundle.enabled ? 'enabled' : 'disabled';
  const readiness = evaluateAgentSkillBundleReadiness(bundle, skills);
  const review = formatAgentRecordReviewState(bundle.reviewState);
  const missing = [
    ...readiness.missingRequirements.map(formatAgentSkillRequirement),
    ...readiness.missingSkillIds.map((skillId) => `skill ${skillId}`),
  ];
  const ready = readiness.ready ? 'ready' : `needs ${missing.join(',')}`;
  return `  ${bundle.id}  ${enabled}  ${review}  ${ready}  ${bundle.name} - ${bundle.description}  skills ${bundle.skillIds.join(', ')}`;
}

function renderList(title: string, registry: AgentSkillRegistry, skills: readonly AgentSkillRecord[], emptyMessage?: string): string {
  const snapshot = registry.snapshot();
  if (skills.length === 0) {
    return emptyMessage
      ? `${title}\n  ${emptyMessage}`
      : `${title}\n  No Agent-local skills yet. Make one with /my-skills create.`;
  }
  return [
    `${title} (${skills.length})`,
    `  store ${snapshot.path}`,
    `  enabled ${snapshot.enabledSkills.length}`,
    ...skills.map(summarizeSkill),
  ].join('\n');
}

function summarizeDiscoveredSkill(skill: SkillRecord): string {
  const description = skill.description ? ` - ${skill.description}` : '';
  const dependencies = skill.dependencies.length > 0 ? ` deps ${skill.dependencies.join(', ')}` : '';
  const includes = skill.includes.length > 0 ? ` includes ${skill.includes.join(', ')}` : '';
  return `  ${skill.name}  ${skill.origin}${description}${dependencies}${includes}\n    path ${skill.path}`;
}

function renderDiscoveredSkills(skills: readonly SkillRecord[]): string {
  if (skills.length === 0) {
    return [
      'Discovered Agent skill files',
      '  No SKILL.md or .md skill files found in project/global Agent skill folders.',
      '  Search roots: .goodvibes/skills, .goodvibes/agent/skills, ~/.goodvibes/skills, ~/.goodvibes/agent/skills',
    ].join('\n');
  }
  return [
    `Discovered Agent skill files (${skills.length})`,
    ...skills.map(summarizeDiscoveredSkill),
    '',
    'Import one with: /my-skills import-discovered <name>',
  ].join('\n');
}

function discoveredSkillLookupValues(skill: SkillRecord): readonly string[] {
  const slug = skill.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = skill.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [
    skill.name,
    slug,
    skill.path,
    basename,
  ].map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function findDiscoveredSkill(skills: readonly SkillRecord[], idOrName: string): SkillRecord | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return skills.find((skill) => discoveredSkillLookupValues(skill).includes(lookup)) ?? null;
}

function frontmatterList(skill: SkillRecord, key: string): readonly string[] {
  const value = skill.frontmatter[key];
  if (!value) return [];
  return splitList(value);
}

function frontmatterAnyList(skill: SkillRecord, keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const values = frontmatterList(skill, key);
    if (values.length > 0) return values;
  }
  return [];
}

async function importDiscoveredSkill(name: string, enable: boolean, ctx: CommandContext, skillRegistry: AgentSkillRegistry): Promise<string> {
  const discovered = findDiscoveredSkill(await discoverSkills(requireShellPaths(ctx)), name);
  if (!discovered) throw commandRefusal(`Unknown discovered Agent skill ${name}`, 'Run /my-skills discover to see the skill files found.');
  // "Switch it on now": the owner may switch on what was just imported; nobody has reviewed it, so the model may not.
  if (enable) assertActorMayEnable(actorOf(ctx), 'skill', discovered.name, 'fresh');
  const skill = skillRegistry.create({
    name: discovered.name,
    description: discovered.description || `Imported skill from ${discovered.origin} skill file.`,
    procedure: discovered.body,
    triggers: frontmatterList(discovered, 'triggers'),
    tags: frontmatterList(discovered, 'tags'),
    requirements: buildAgentSkillRequirements({
      env: frontmatterAnyList(discovered, ['requiresEnv', 'requires-env', 'requires_env']),
      commands: frontmatterAnyList(discovered, ['requiresCommands', 'requires-commands', 'requires_commands', 'commands']),
    }),
    enabled: enable,
    source: 'imported',
    provenance: `Imported file (${discovered.origin}): ${discovered.path}`,
  });
  return formatSkillReceipt('Imported Agent skill', skill, [
    enable ? '  enabled yes, switched on at import by the owner' : '  enabled no, imported switched off (review it, then switch it on)',
    '  review pending',
  ]);
}

function renderBundleList(title: string, registry: AgentSkillRegistry, bundles: readonly AgentSkillBundleRecord[], emptyMessage?: string): string {
  const snapshot = registry.snapshot();
  if (bundles.length === 0) {
    return emptyMessage
      ? `${title}\n  ${emptyMessage}`
      : `${title}\n  No Agent-local skill bundles yet. Make one with /my-skills bundle-create.`;
  }
  return [
    `${title} (${bundles.length})`,
    `  store ${snapshot.path}`,
    `  enabled bundles: ${snapshot.enabledBundles.length}`,
    `  active skills: ${snapshot.activeSkills.length}`,
    ...bundles.map((bundle) => summarizeBundle(bundle, snapshot.skills)),
  ].join('\n');
}

function renderSkill(skill: AgentSkillRecord): string {
  const readiness = evaluateAgentSkillReadiness(skill);
  return [
    `Skill ${skill.name}`,
    `  id ${skill.id}`,
    `  enabled: ${skill.enabled ? 'yes' : 'no'}`,
    `  readiness: ${readiness.ready ? 'ready' : 'needs setup'}`,
    `  requirements: ${skill.requirements.map(formatAgentSkillRequirement).join(', ') || '(none)'}`,
    readiness.missing.length > 0 ? `  missing: ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}` : '',
    `  review: ${formatAgentRecordReviewState(skill.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(skill.source, skill.provenance)}`,
    `  tags: ${skill.tags.join(', ') || '(none)'}`,
    `  triggers: ${skill.triggers.join(', ') || '(manual)'}`,
    `  created: ${skill.createdAt}`,
    `  updated: ${skill.updatedAt}`,
    skill.staleReason ? `  stale reason: ${skill.staleReason}` : '',
    '',
    skill.description,
    '',
    skill.procedure,
  ].filter(Boolean).join('\n');
}

function renderBundle(bundle: AgentSkillBundleRecord, registry: AgentSkillRegistry): string {
  const skills = bundle.skillIds
    .map((skillId) => registry.get(skillId))
    .filter((skill): skill is AgentSkillRecord => skill !== null);
  const readiness = evaluateAgentSkillBundleReadiness(bundle, registry.snapshot().skills);
  const missing = [
    ...readiness.missingRequirements.map(formatAgentSkillRequirement),
    ...readiness.missingSkillIds.map((skillId) => `skill ${skillId}`),
  ];
  return [
    `Skill Bundle ${bundle.name}`,
    `  id ${bundle.id}`,
    `  enabled: ${bundle.enabled ? 'yes' : 'no'}`,
    `  readiness: ${readiness.ready ? 'ready' : 'needs setup'}`,
    missing.length > 0 ? `  missing: ${missing.join(', ')}` : '',
    `  review: ${formatAgentRecordReviewState(bundle.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(bundle.source, bundle.provenance)}`,
    `  skills: ${bundle.skillIds.join(', ')}`,
    `  created: ${bundle.createdAt}`,
    `  updated: ${bundle.updatedAt}`,
    bundle.staleReason ? `  stale reason: ${bundle.staleReason}` : '',
    '',
    bundle.description,
    '',
    ...skills.map((skill) => `- ${skill.id}: ${skill.name} - ${skill.description}`),
  ].filter(Boolean).join('\n');
}

/** A failed step is the command's failed result: a refusal passes through, anything else is reported as failed. */
async function guarded(ctx: CommandContext, run: (registry: AgentSkillRegistry) => string | Promise<string>): Promise<string> {
  try {
    return await run(registryFromContext(ctx));
  } catch (error) {
    if (readRefusalLike(error)) throw error;
    throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}
function readRefusalLike(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'refusal' in error;
}

const LOCAL = 'Agent-local skills are kept on this machine.';

const SKILLS = defineList<CommandContext>({
  name: 'my-skills',
  async read(ctx) {
    return registryFromContext(ctx).list().map((skill): ListRow => ({ value: skill.id, label: skill.name, detail: skill.description, state: `${skill.enabled ? 'on' : 'off'}, ${formatAgentRecordReviewState(skill.reviewState)}` }));
  },
  operator: { terminalOnly: LOCAL },
});
const BUNDLES = defineList<CommandContext>({
  name: 'my-skills.bundles',
  async read(ctx) {
    return registryFromContext(ctx).listBundles().map((bundle): ListRow => ({ value: bundle.id, label: bundle.name, detail: bundle.description, state: `${bundle.enabled ? 'on' : 'off'}, ${formatAgentRecordReviewState(bundle.reviewState)}` }));
  },
  operator: { terminalOnly: LOCAL },
});
const DISCOVERED = defineList<CommandContext>({
  name: 'my-skills.discovered',
  async read(ctx) { return (await discoverSkills(requireShellPaths(ctx))).map((skill): ListRow => ({ value: skill.name, label: skill.name, detail: skill.path, state: skill.origin })); },
  operator: { terminalOnly: LOCAL },
});

const SKILL: InputDescription = listInput({ id: 'skill', label: 'Skill', help: 'Your Agent-local skills', list: SKILLS });
const BUNDLE: InputDescription = listInput({ id: 'bundle', label: 'Bundle', help: 'Your skill bundles', list: BUNDLES });
const text = (id: string, label: string, help: string, typed: InputDescription['typed'], optional?: { default: string; means: string }, kind: InputDescription['kind'] = 'text'): InputDescription =>
  textInput({ id, label, help, why: 'your own words', typed, kind, ...(optional ? { optional } : {}) });
const LIST = (id: string, label: string, help: string, flag: `--${string}`, means: string): InputDescription =>
  textInput({ id, label, help: `${help}, separated by commas`, why: 'names you choose', typed: { flag }, optional: { default: '', means } });
const SWITCH_ON = (help: string): InputDescription => ({
  id: 'enabled', label: 'Switch it on now', help, kind: 'yes-no', choices: [{ value: 'no', label: 'No, after a review' }, { value: 'yes', label: 'Yes' }],
  required: { default: 'no', defaultMeans: 'off until you review it' }, typed: { flag: '--enabled' },
});

function change(fields: Pick<ActionDescription<CommandContext>, 'id' | 'label' | 'word' | 'sentence' | 'inputs' | 'example'> & Partial<Pick<ActionDescription<CommandContext>, 'risk' | 'undoneBy'>> & { readonly run: (values: ActionValues, ctx: CommandContext, registry: AgentSkillRegistry) => string | Promise<string> }): ActionDescription<CommandContext> {
  const { run, ...rest } = fields;
  return { risk: 'none', ...rest, done: '', touches: 'this-machine', lasts: 'kept', operator: { terminalOnly: LOCAL }, run: (values, ctx) => guarded(ctx, (registry) => run(values, ctx, registry)) };
}
function show(fields: Pick<ActionDescription<CommandContext>, 'id' | 'label' | 'word' | 'sentence'> & Partial<Pick<ActionDescription<CommandContext>, 'inputs' | 'example'>> & { readonly run: (values: ActionValues, ctx: CommandContext, registry: AgentSkillRegistry) => string | Promise<string> }): ActionDescription<CommandContext> {
  const { run, ...rest } = fields;
  return readAction<CommandContext>({ ...rest, run: (values, ctx) => guarded(ctx, (registry) => run(values, ctx, registry)) });
}

function requirements(values: ActionValues, registry: AgentSkillRegistry, id?: string) {
  if (!values.env && !values.commands && id) return undefined;
  return buildAgentSkillRequirements({
    // A list for one kind must not erase the other kind the skill already has.
    env: values.env ? splitList(values.env) : id ? existingRequirementNames(registry, id, 'env') : [],
    commands: values.commands ? splitList(values.commands) : id ? existingRequirementNames(registry, id, 'command') : [],
  });
}

const MY_SKILLS = defineCommand<CommandContext>({
  name: 'my-skills',
  // --yes confirms only right after the action word: the same word in the text is text.
  leadingFlagsOnly: true,
  title: 'My skills',
  summary: 'Keep the Agent\'s own skills: step-by-step procedures it follows when a task matches',
  group: 'Extensions',
  report: 'list',
  firstScreenRows: [
    'list', 'show', 'create', 'search',
    { label: 'Switch a skill on or off, or review it', actions: ['enable', 'disable', 'review', 'stale', 'attention', 'enabled', 'update', 'delete'] },
    { label: 'Bring skills in or share them', actions: ['discover', 'import-discovered', 'import-standard', 'export-standard'] },
    { label: 'Skill bundles', actions: ['bundles', 'bundle-show', 'bundle-create', 'bundle-search', 'bundle-enable', 'bundle-disable', 'bundle-review', 'bundle-stale', 'bundle-update', 'bundle-delete', 'bundles-enabled', 'bundles-attention'] },
  ],
  actions: [
    show({ id: 'list', label: 'See your skills', word: 'list', sentence: 'Lists every Agent-local skill with its state, review and readiness.', run: (_v, _c, registry) => renderList('Agent Skills', registry, registry.list()) }),
    show({ id: 'enabled', label: 'See the skills that are on', word: 'enabled', sentence: 'Lists the skills that are switched on.', run: (_v, _c, registry) => renderList('Enabled Agent Skills', registry, registry.snapshot().enabledSkills) }),
    show({ id: 'attention', label: 'See skills that need setting up', word: 'attention', sentence: 'Lists skills missing an environment variable or a command they need.', run: (_v, _c, registry) => renderList('Agent Skills needing setup', registry, registry.list().filter((skill) => !evaluateAgentSkillReadiness(skill).ready), 'No Agent-local skills need setup.') }),
    show({
      id: 'search', label: 'Search your skills', word: 'search', inputs: [text('query', 'Looking for', 'Words to search for', { tail: true })],
      sentence: 'Lists skills that match "{query}".', example: { query: 'release' },
      run: (values, _c, registry) => renderList(`Agent Skills matching "${values.query}"`, registry, registry.search(values.query!)),
    }),
    show({
      id: 'show', label: 'See one skill', word: 'show', inputs: [SKILL], sentence: 'Shows {skill}\'s procedure, requirements, review and origin.', example: { skill: 'sk-release' },
      run: (values, _c, registry) => { const skill = registry.get(values.skill!); if (!skill) throw commandRefusal(`Unknown Agent skill ${values.skill}`, '/my-skills list shows them.'); return renderSkill(skill); },
    }),
    change({
      id: 'create', label: 'Make a skill', word: 'create',
      inputs: [
        text('name', 'Name', 'A short name', { flag: '--name' }),
        text('description', 'What it is for', 'One line the model matches tasks against', { flag: '--description' }),
        text('procedure', 'Steps', 'What to do, step by step', { tail: true }, undefined, 'long-text'),
        LIST('triggers', 'When it applies', 'Words that bring it up', '--triggers', 'only when asked for'),
        LIST('tags', 'Tags', 'Tags', '--tags', 'none'),
        LIST('env', 'Environment it needs', 'Environment variable names', '--requires-env', 'none'),
        LIST('commands', 'Commands it needs', 'Program names', '--requires-command', 'none'),
        SWITCH_ON('Switch it on at once, or after you review it'),
      ],
      sentence: 'A skill {name} ("{description}") is kept until you change it; its steps: {procedure}', undoneBy: 'delete',
      example: { name: 'release notes', description: 'Write release notes from merged changes', procedure: 'List merged pull requests, then group them.' },
      run: (values, ctx, registry) => {
        if (values.enabled === 'yes') assertActorMayEnable(actorOf(ctx), 'skill', values.name!, 'fresh');
        return formatSkillReceipt('Created Agent skill', registry.create({
          name: values.name!, description: values.description!, procedure: values.procedure!,
          triggers: splitList(values.triggers), tags: splitList(values.tags),
          requirements: requirements(values, registry)!, enabled: values.enabled === 'yes', source: 'user', provenance: 'Command',
        }));
      },
    }),
    change({
      id: 'update', label: 'Change a skill', word: 'update',
      inputs: [
        SKILL,
        text('name', 'Name', 'A new name', { flag: '--name' }, { default: '', means: 'unchanged' }),
        text('description', 'What it is for', 'A new line', { flag: '--description' }, { default: '', means: 'unchanged' }),
        text('procedure', 'Steps', 'New steps', { flag: '--procedure' }, { default: '', means: 'unchanged' }, 'long-text'),
        LIST('triggers', 'When it applies', 'Words that bring it up', '--triggers', 'unchanged'),
        LIST('tags', 'Tags', 'Tags', '--tags', 'unchanged'),
        LIST('env', 'Environment it needs', 'Environment variable names', '--requires-env', 'unchanged'),
        LIST('commands', 'Commands it needs', 'Program names', '--requires-command', 'unchanged'),
      ],
      sentence: '{skill} is changed to what you gave until you change it.', example: { skill: 'sk-release', description: 'Write release notes for a tag' },
      run: (values, _c, registry) => formatSkillReceipt('Updated Agent skill', registry.update(values.skill!, {
        name: values.name || undefined, description: values.description || undefined, procedure: values.procedure || undefined,
        triggers: values.triggers ? splitList(values.triggers) : undefined, tags: values.tags ? splitList(values.tags) : undefined,
        requirements: requirements(values, registry, values.skill!), provenance: 'Command',
      })),
    }),
    change({
      id: 'enable', label: 'Switch a skill on', word: 'enable', inputs: [SKILL], sentence: 'The model may follow {skill} until you change it.', undoneBy: 'disable', example: { skill: 'sk-release' },
      run: (values, ctx, registry) => { assertActorMayEnable(actorOf(ctx), 'skill', values.skill!, registry.get(values.skill!)?.reviewState); return formatSkillReceipt('Enabled Agent skill', registry.setEnabled(values.skill!, true)); },
    }),
    change({
      id: 'disable', label: 'Switch a skill off', word: 'disable', inputs: [SKILL], sentence: 'The model stops following {skill} until you change it.', undoneBy: 'enable', example: { skill: 'sk-release' },
      run: (values, _c, registry) => formatSkillReceipt('Disabled Agent skill', registry.setEnabled(values.skill!, false)),
    }),
    change({
      id: 'review', label: 'Mark a skill reviewed', word: 'review', inputs: [SKILL], sentence: '{skill} is marked reviewed by you until you change it, so it may be switched on.', example: { skill: 'sk-release' },
      run: (values, ctx, registry) => { assertActorMayMarkReviewed(actorOf(ctx), 'skill', values.skill!); return formatSkillReceipt('Reviewed Agent skill', registry.markReviewed(values.skill!)); },
    }),
    change({
      id: 'stale', label: 'Mark a skill out of date', word: 'stale', inputs: [SKILL, text('reason', 'Why', 'What is out of date', { tail: true })],
      sentence: '{skill} is marked out of date ("{reason}") until you change it.', example: { skill: 'sk-release', reason: 'the release script moved' },
      run: (values, _c, registry) => formatSkillReceipt('Marked Agent skill stale', registry.markStale(values.skill!, values.reason!)),
    }),
    change({
      id: 'delete', label: 'Delete a skill', word: 'delete', inputs: [SKILL], sentence: '{skill} is removed from the Agent-local registry.', risk: 'cannot-be-undone', example: { skill: 'sk-release' },
      run: (values, _c, registry) => formatSkillReceipt('Deleted Agent skill', registry.deleteSkill(values.skill!)),
    }),
    show({ id: 'discover', label: 'See skill files found on disk', word: 'discover', sentence: 'Lists SKILL.md and .md skill files in the project and global skill folders.', run: async (_v, ctx) => renderDiscoveredSkills(await discoverSkills(requireShellPaths(ctx))) }),
    change({
      id: 'import-discovered', label: 'Import a skill file found on disk', word: 'import-discovered',
      inputs: [listInput({ id: 'file', label: 'Skill file', help: 'Skill files found on disk', list: DISCOVERED }), SWITCH_ON('Switch it on at once, or after you review it')],
      sentence: '{file} is copied into your Agent-local skills, off until you review it unless you switch it on, until you change it.', undoneBy: 'delete', example: { file: 'release-notes' },
      run: (values, ctx, registry) => importDiscoveredSkill(values.file!, values.enabled === 'yes', ctx, registry),
    }),
    change({
      id: 'import-standard', label: 'Import a shared SKILL.md', word: 'import-standard',
      inputs: [textInput({ id: 'path', label: 'SKILL.md file', help: 'A skill in the shared SKILL.md format', why: 'a file path on this machine', kind: 'path', typed: { position: 1 } })],
      sentence: 'The skill in {path} is added, off until you review it, until you change it.', undoneBy: 'delete', example: { path: 'skills/release-notes/SKILL.md' },
      run: (values, ctx, registry) => {
        const sourcePath = resolveCommandFilePath(ctx, values.path!, 'read');
        if (sourcePath === null) throw commandRefusal(`${values.path} could not be read.`);
        const content = readFileSync(sourcePath, 'utf-8');
        const parseResult = parseSkillStandardMarkdown(content);
        if ('error' in parseResult) throw commandRefusal(`Skill standard import rejected: ${parseResult.error}`);
        const skill = registry.importFromStandard(content);
        return formatSkillReceipt('Imported shared skill', skill, [
          `  source ${sourcePath}`, `  review-state ${skill.reviewState}`,
          `  off until you review it (/my-skills show ${skill.id}) and switch it on (/my-skills enable ${skill.id}); /my-skills delete ${skill.id} removes it`,
        ]);
      },
    }),
    {
      id: 'export-standard', label: 'Save a skill as a shared SKILL.md', word: 'export-standard',
      inputs: [SKILL, textInput({ id: 'dir', label: 'Folder', help: 'Where to write its SKILL.md', why: 'a folder on this machine', kind: 'path', typed: { position: 2 } }),
        { id: 'overwrite', label: 'If a SKILL.md is there', help: 'Keep it, or replace it', kind: 'choice', choices: [{ value: 'keep', label: 'Refuse and keep it' }, { value: 'replace', label: 'Replace it', risk: 'cannot-be-undone' }], required: { default: 'keep', defaultMeans: 'refuse and keep it' }, typed: { flag: '--overwrite', switchOn: 'replace' } }],
      sentence: '{skill} is written as a SKILL.md into {dir}.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none', operator: { terminalOnly: LOCAL }, example: { skill: 'sk-release', dir: 'skills/release-notes' },
      run: (values, ctx) => guarded(ctx, (registry) => {
        const skill = registry.get(values.skill!);
        if (!skill) throw commandRefusal(`Unknown Agent skill ${values.skill}`, '/my-skills list shows the Agent-local skills.');
        const targetDir = resolveCommandFilePath(ctx, values.dir!, 'write');
        if (targetDir === null) throw commandRefusal(`${values.dir} cannot be written.`);
        const overwrite = values.overwrite === 'replace';
        const replaced = overwrite && existsSync(skillStandardFilePath(skill.name, targetDir));
        const written = registry.exportToStandard(skill.id, targetDir, overwrite);
        return formatSkillReceipt('Exported Agent skill', skill, [`  file ${written}${replaced ? ' (replaced the file that was there)' : ''}`]);
      }),
    },
    show({ id: 'bundles', label: 'See your skill bundles', word: 'bundles', sentence: 'Lists every skill bundle with its state, review and readiness.', run: (_v, _c, registry) => renderBundleList('Agent Skill Bundles', registry, registry.listBundles()) }),
    show({ id: 'bundles-enabled', label: 'See the bundles that are on', word: 'bundles-enabled', sentence: 'Lists the skill bundles that are switched on.', run: (_v, _c, registry) => renderBundleList('Enabled Agent Skill Bundles', registry, registry.snapshot().enabledBundles) }),
    show({
      id: 'bundles-attention', label: 'See bundles that need setting up', word: 'bundles-attention', sentence: 'Lists bundles missing a skill or something a skill needs.',
      run: (_v, _c, registry) => { const snapshot = registry.snapshot(); return renderBundleList('Agent Skill Bundles needing setup', registry, snapshot.bundles.filter((bundle) => !evaluateAgentSkillBundleReadiness(bundle, snapshot.skills).ready), 'No Agent-local skill bundles need setup.'); },
    }),
    show({
      id: 'bundle-search', label: 'Search your skill bundles', word: 'bundle-search', inputs: [text('query', 'Looking for', 'Words to search for', { tail: true })],
      sentence: 'Lists skill bundles that match "{query}".', example: { query: 'release' },
      run: (values, _c, registry) => renderBundleList(`Agent Skill Bundles matching "${values.query}"`, registry, registry.searchBundles(values.query!)),
    }),
    show({
      id: 'bundle-show', label: 'See one skill bundle', word: 'bundle-show', inputs: [BUNDLE], sentence: 'Shows {bundle}\'s skills, readiness and review.', example: { bundle: 'sb-release' },
      run: (values, _c, registry) => { const bundle = registry.getBundle(values.bundle!); if (!bundle) throw commandRefusal(`Unknown Agent skill bundle ${values.bundle}`); return renderBundle(bundle, registry); },
    }),
    change({
      id: 'bundle-create', label: 'Make a skill bundle', word: 'bundle-create',
      inputs: [text('name', 'Name', 'A short name', { flag: '--name' }), text('description', 'What it is for', 'One line', { flag: '--description' }),
        textInput({ id: 'skills', label: 'Skills in it', help: 'Skill ids, separated by commas', why: 'skill ids from /my-skills list', typed: { flag: '--skills' } }), SWITCH_ON('Switch it on at once, or after you review it')],
      sentence: 'A skill bundle {name} ("{description}") of {skills} is kept until you change it.', undoneBy: 'bundle-delete', example: { name: 'releases', description: 'Everything for a release', skills: 'sk-release,sk-changelog' },
      run: (values, ctx, registry) => {
        if (values.enabled === 'yes') assertActorMayEnable(actorOf(ctx), 'skill bundle', values.name!, 'fresh');
        return formatSkillReceipt('Created Agent skill bundle', registry.createBundle({ name: values.name!, description: values.description!, skillIds: splitList(values.skills), enabled: values.enabled === 'yes', source: 'user', provenance: 'Command' }));
      },
    }),
    change({
      id: 'bundle-update', label: 'Change a skill bundle', word: 'bundle-update',
      inputs: [BUNDLE, text('name', 'Name', 'A new name', { flag: '--name' }, { default: '', means: 'unchanged' }), text('description', 'What it is for', 'A new line', { flag: '--description' }, { default: '', means: 'unchanged' }),
        textInput({ id: 'skills', label: 'Skills in it', help: 'Skill ids, separated by commas', why: 'skill ids from /my-skills list', typed: { flag: '--skills' }, optional: { default: '', means: 'unchanged' } })],
      sentence: '{bundle} is changed to what you gave until you change it.', example: { bundle: 'sb-release', skills: 'sk-release' },
      run: (values, _c, registry) => formatSkillReceipt('Updated Agent skill bundle', registry.updateBundle(values.bundle!, {
        name: values.name || undefined, description: values.description || undefined, skillIds: values.skills ? splitList(values.skills) : undefined, provenance: 'Command',
      })),
    }),
    change({
      id: 'bundle-enable', label: 'Switch a skill bundle on', word: 'bundle-enable', inputs: [BUNDLE], sentence: 'The skills of {bundle} are in use until you change it.', undoneBy: 'bundle-disable', example: { bundle: 'sb-release' },
      run: (values, ctx, registry) => { assertActorMayEnable(actorOf(ctx), 'skill bundle', values.bundle!, registry.getBundle(values.bundle!)?.reviewState); return formatSkillReceipt('Enabled Agent skill bundle', registry.setBundleEnabled(values.bundle!, true)); },
    }),
    change({
      id: 'bundle-disable', label: 'Switch a skill bundle off', word: 'bundle-disable', inputs: [BUNDLE], sentence: '{bundle} is out of use until you change it.', undoneBy: 'bundle-enable', example: { bundle: 'sb-release' },
      run: (values, _c, registry) => formatSkillReceipt('Disabled Agent skill bundle', registry.setBundleEnabled(values.bundle!, false)),
    }),
    change({
      id: 'bundle-review', label: 'Mark a skill bundle reviewed', word: 'bundle-review', inputs: [BUNDLE], sentence: '{bundle} is marked reviewed by you until you change it, so it may be switched on.', example: { bundle: 'sb-release' },
      run: (values, ctx, registry) => { assertActorMayMarkReviewed(actorOf(ctx), 'skill bundle', values.bundle!); return formatSkillReceipt('Reviewed Agent skill bundle', registry.markBundleReviewed(values.bundle!)); },
    }),
    change({
      id: 'bundle-stale', label: 'Mark a skill bundle out of date', word: 'bundle-stale', inputs: [BUNDLE, text('reason', 'Why', 'What is out of date', { tail: true })],
      sentence: '{bundle} is marked out of date ("{reason}") until you change it.', example: { bundle: 'sb-release', reason: 'a skill in it was removed' },
      run: (values, _c, registry) => formatSkillReceipt('Marked Agent skill bundle stale', registry.markBundleStale(values.bundle!, values.reason!)),
    }),
    change({
      id: 'bundle-delete', label: 'Delete a skill bundle', word: 'bundle-delete', inputs: [BUNDLE], sentence: '{bundle} is removed from the Agent-local registry; its skills stay.', risk: 'cannot-be-undone', example: { bundle: 'sb-release' },
      run: (values, _c, registry) => formatSkillReceipt('Deleted Agent skill bundle', registry.deleteBundle(values.bundle!)),
    }),
  ],
});

export function registerAgentSkillsRuntimeCommands(registry: CommandRegistry): void {
  registry.register(MY_SKILLS);
}

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { AgentPersonaRegistry, assertNoSecretLikeText } from '@goodvibes/engine/terminal-shell/agent-turn/persona-registry';
import { AgentRoutineRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/routine-registry';
import { AgentSkillRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/skill-registry';
import { discoverVibeFiles } from '@goodvibes/engine/terminal-shell/agent-turn/vibe-file';
import { discoverPersonas, discoverRoutines, type DiscoveredPersonaRecord, type DiscoveredRoutineRecord } from '@goodvibes/engine/terminal-shell/agent-turn/record-discovery';
import { discoverSkills, type SkillRecord } from './skill-discovery.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import { STARTER_TEMPLATES, type AgentRuntimeProfileStarterTemplate, type AgentRuntimeProfileStarterTemplateFile } from './runtime-profile-starters.ts';

export type AgentRuntimeProfileTemplateId = string;
export type AgentRuntimeProfileTemplateSource = 'builtin' | 'local';

export interface AgentRuntimeProfileTemplateSummary {
  readonly id: AgentRuntimeProfileTemplateId;
  readonly name: string;
  readonly description: string;
  readonly personaName: string;
  readonly skillNames: readonly string[];
  readonly routineNames: readonly string[];
  readonly vibeIncluded?: boolean;
  readonly source: AgentRuntimeProfileTemplateSource;
  readonly path?: string;
}

export interface AgentRuntimeProfileResolution {
  readonly id: string;
  readonly homeDirectory: string;
}

export interface AgentRuntimeProfileInfo extends AgentRuntimeProfileResolution {
  readonly createdAt: string | null;
  readonly starterTemplateId?: AgentRuntimeProfileTemplateId;
  readonly starterTemplateName?: string;
  readonly starterTemplateApplication?: AgentRuntimeProfileTemplateApplication;
}

export interface AgentRuntimeProfileSelection extends AgentRuntimeProfileResolution {
  readonly selectedAt: string | null;
  readonly path: string;
  readonly exists: boolean;
}

export interface AgentRuntimeProfileTemplateApplication {
  readonly id: AgentRuntimeProfileTemplateId;
  readonly name: string;
  readonly source: AgentRuntimeProfileTemplateSource;
  readonly appliedAt: string;
  readonly personaIds: readonly string[];
  readonly skillIds: readonly string[];
  readonly routineIds: readonly string[];
  readonly vibePath?: string;
  /** True when `vibePath` is `VIBE.md.pending`, held for review: nothing reads it until it is renamed to VIBE.md. */
  readonly vibePending?: boolean;
  /**
   * A built-in starter's records are written reviewed (the text ships in this
   * build). A local or discovered template's records start fresh; these are
   * the steps that review each one, its VIBE.md included. Empty when nothing
   * waits for review.
   */
  readonly reviewCommands: readonly string[];
}

export interface CreateAgentRuntimeProfileOptions {
  readonly templateId?: AgentRuntimeProfileTemplateId;
}

type AgentRuntimeProfileTemplateShellPaths =
  Pick<ShellPathService, 'homeDirectory' | 'workingDirectory'>
  & Partial<Pick<ShellPathService, 'resolveUserPath' | 'expandHomePath' | 'resolveWorkspacePath'>>;

export interface AgentRuntimeProfileTemplateExportOptions {
  readonly includeVibe?: boolean;
  readonly shellPaths?: AgentRuntimeProfileTemplateShellPaths;
}

export interface CreateAgentRuntimeProfileTemplateFromDiscoveredOptions {
  readonly id: AgentRuntimeProfileTemplateId;
  readonly name?: string;
  readonly description?: string;
  readonly persona?: string;
  readonly skills?: readonly string[];
  readonly routines?: readonly string[];
  readonly includeVibe?: boolean;
  readonly replace?: boolean;
}

export interface CreateAgentRuntimeProfileFromDiscoveredOptions extends Omit<CreateAgentRuntimeProfileTemplateFromDiscoveredOptions, 'id'> {
  readonly profileName: string;
  readonly templateId?: AgentRuntimeProfileTemplateId;
}

export interface AgentRuntimeProfileCommandResult {
  readonly ok: boolean;
  readonly kind:
    | 'agent.profiles.list'
    | 'agent.profiles.show'
    | 'agent.profiles.templates'
    | 'agent.profiles.template.export'
    | 'agent.profiles.template.import'
    | 'agent.profiles.template.from_discovered'
    | 'agent.profiles.create_from_discovered'
    | 'agent.profiles.create'
    | 'agent.profiles.default'
    | 'agent.profiles.default.clear'
    | 'agent.profiles.delete'
    | 'agent.profiles.error';
  readonly data?: {
    readonly profiles?: readonly AgentRuntimeProfileInfo[];
    readonly profile?: AgentRuntimeProfileInfo;
    readonly selectedProfile?: AgentRuntimeProfileSelection;
    readonly templates?: readonly AgentRuntimeProfileTemplateSummary[];
    readonly appliedTemplate?: AgentRuntimeProfileTemplateApplication;
    readonly template?: AgentRuntimeProfileTemplateSummary;
    readonly path?: string;
    readonly nextCommand?: string;
  };
  readonly error?: string;
}

const PROFILE_CREATED_FILE = 'profile.json';
const PROFILE_SELECTION_FILE = 'profile-selection.json';
const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentRuntimeProfileId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/[-_]{2,}/g, '-');
}

/** A name or template the command cannot take: a usage error, not a missing profile or a failed write. */
export class AgentProfileUsageError extends Error {
  override readonly name = 'AgentProfileUsageError';
}

/** A well-formed profile name with no profile home behind it. */
export class AgentProfileNotFoundError extends Error {
  override readonly name = 'AgentProfileNotFoundError';
  constructor(readonly profileId: string, message: string) {
    super(message);
  }
}

export function assertValidAgentRuntimeProfileId(value: string): string {
  const raw = value.trim();
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    throw new AgentProfileUsageError('Agent profile names cannot contain path traversal sequences.');
  }
  const normalized = normalizeAgentRuntimeProfileId(value);
  if (!PROFILE_ID_PATTERN.test(normalized)) {
    throw new AgentProfileUsageError('Agent profile names must normalize to 1-64 lowercase letters, numbers, dots, underscores, or dashes.');
  }
  return normalized;
}

/**
 * The home that holds every profile, for any session's home. A profile
 * session's home is `<base>/.goodvibes/agent/profile-homes/<id>`, a path this
 * module builds, so the base is read from its shape; any other home is the
 * base itself. Every profile path below goes through it, so list, create,
 * default and delete reach the same profiles from inside a profile session as
 * from a plain one.
 */
export function agentRuntimeProfileBaseHome(homeDirectory: string): string {
  if (!homeDirectory) return homeDirectory;
  const home = resolve(homeDirectory);
  const base = resolve(home, '..', '..', '..', '..');
  return dirname(home) === join(base, '.goodvibes', 'agent', 'profile-homes') && PROFILE_ID_PATTERN.test(basename(home)) ? base : homeDirectory;
}

/** The Agent home (profile) a session runs in, by name; null in the default home. */
export function agentRuntimeProfileName(homeDirectory: string): string | null {
  return homeDirectory && agentRuntimeProfileBaseHome(homeDirectory) !== homeDirectory ? basename(homeDirectory) : null;
}

export function getAgentRuntimeProfilesRoot(baseHomeDirectory: string): string {
  return join(agentRuntimeProfileBaseHome(baseHomeDirectory), '.goodvibes', 'agent', 'profile-homes');
}

export function getAgentRuntimeProfileTemplatesRoot(baseHomeDirectory: string): string {
  return join(agentRuntimeProfileBaseHome(baseHomeDirectory), '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'profile-starters');
}

export function getAgentRuntimeProfileSelectionPath(baseHomeDirectory: string): string {
  return join(agentRuntimeProfileBaseHome(baseHomeDirectory), '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, PROFILE_SELECTION_FILE);
}

/**
 * Where a profile's home is. With `mustExist`, a name with no profile behind it
 * is refused (AgentProfileNotFoundError) instead of naming a home that start-up
 * would then create empty: a misspelt `--agent-profile` must not become a new
 * profile.
 */
export function resolveAgentRuntimeProfileHome(
  baseHomeDirectory: string,
  profileName: string,
  options: { readonly mustExist?: boolean } = {},
): AgentRuntimeProfileResolution {
  const id = assertValidAgentRuntimeProfileId(profileName);
  const homeDirectory = join(getAgentRuntimeProfilesRoot(baseHomeDirectory), id);
  if (options.mustExist && !existsSync(homeDirectory)) {
    throw new AgentProfileNotFoundError(id, missingProfileMessage(baseHomeDirectory, id));
  }
  return { id, homeDirectory };
}

function missingProfileMessage(baseHomeDirectory: string, id: string): string {
  const existing = listAgentRuntimeProfiles(baseHomeDirectory).map((profile) => profile.id);
  return [
    `No Agent profile named ${id}.`,
    `Existing: ${existing.length > 0 ? existing.join(', ') : 'none'}.`,
    `Create it with: goodvibes-agent profiles create ${id} --yes`,
  ].join(' ');
}

export function readAgentRuntimeProfileSelection(baseHomeDirectory: string): AgentRuntimeProfileSelection | null {
  const path = getAgentRuntimeProfileSelectionPath(baseHomeDirectory);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(raw)) return null;
    const profileId = raw.profileId;
    if (typeof profileId !== 'string') return null;
    const resolution = resolveAgentRuntimeProfileHome(baseHomeDirectory, profileId);
    const selectedAt = typeof raw.selectedAt === 'string' ? raw.selectedAt : null;
    return {
      ...resolution,
      selectedAt,
      path,
      exists: existsSync(resolution.homeDirectory),
    };
  } catch (error) {
    // Falling back to the default home is right, but not silently: the owner
    // chose a profile and is about to be working in a different one.
    logger.warn('Agent runtime profile selection could not be read; using the default home', {
      path,
      error: summarizeError(error),
    });
    return null;
  }
}

export function resolveSelectedAgentRuntimeProfileHome(baseHomeDirectory: string): AgentRuntimeProfileResolution | null {
  const selection = readAgentRuntimeProfileSelection(baseHomeDirectory);
  if (!selection) return null;
  if (!selection.exists) {
    // The owner chose this profile; starting in another home without a word
    // would look like every session and memory had gone.
    throw new AgentProfileNotFoundError(selection.id, [
      `The default Agent profile ${selection.id} no longer exists.`,
      `Clear the default with: goodvibes-agent profiles default clear --yes, or create it again with: goodvibes-agent profiles create ${selection.id} --yes`,
    ].join(' '));
  }
  return {
    id: selection.id,
    homeDirectory: selection.homeDirectory,
  };
}

function readProfileCreatedAt(homeDirectory: string): string | null {
  const path = join(homeDirectory, PROFILE_CREATED_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (raw && typeof raw === 'object' && typeof raw.createdAt === 'string') return raw.createdAt;
  } catch {
    return null;
  }
  return null;
}

function readProfileStarterTemplate(homeDirectory: string): Pick<AgentRuntimeProfileInfo, 'starterTemplateId' | 'starterTemplateName'> {
  const path = join(homeDirectory, PROFILE_CREATED_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(raw)) return {};
    const starter = raw.starterTemplate;
    if (!isRecord(starter)) return {};
    const id = starter.id;
    const name = starter.name;
    if (!isAgentRuntimeProfileTemplateId(id) || typeof name !== 'string') return {};
    return {
      starterTemplateId: id,
      starterTemplateName: name,
    };
  } catch {
    return {};
  }
}

function buildProfileInfo(baseHomeDirectory: string, id: string): AgentRuntimeProfileInfo {
  const { homeDirectory } = resolveAgentRuntimeProfileHome(baseHomeDirectory, id);
  return {
    id,
    homeDirectory,
    createdAt: readProfileCreatedAt(homeDirectory),
    ...readProfileStarterTemplate(homeDirectory),
  };
}

function profileStorePath(homeDirectory: string, folder: string, file: string): string {
  return join(homeDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, folder, file);
}

export function isAgentRuntimeProfileTemplateId(value: unknown): value is AgentRuntimeProfileTemplateId {
  if (typeof value !== 'string') return false;
  try {
    assertValidAgentRuntimeProfileId(value);
    return true;
  } catch {
    return false;
  }
}

function summarizeTemplate(template: AgentRuntimeProfileStarterTemplate): AgentRuntimeProfileTemplateSummary {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    personaName: template.personaName,
    skillNames: [...template.skillNames],
    routineNames: [...template.routineNames],
    vibeIncluded: Boolean(template.vibe?.body.trim()),
    source: template.source,
    path: template.path,
  };
}

function parseStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function splitFrontmatterList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizedLookupValues(value: string, path?: string): readonly string[] {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = path?.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [value, slug, path ?? '', basename].map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function selectDiscoveredRecord<T extends { readonly name: string; readonly path: string }>(
  records: readonly T[],
  selector: string | undefined,
  label: string,
): T {
  if (records.length === 0) throw new Error(`No discovered Agent ${label} files found.`);
  if (!selector?.trim()) return records[0]!;
  const lookup = selector.trim().toLowerCase();
  const match = records.find((record) => normalizedLookupValues(record.name, record.path).includes(lookup));
  if (!match) throw new Error(`Unknown discovered Agent ${label} ${selector}.`);
  return match;
}

function selectDiscoveredRecords<T extends { readonly name: string; readonly path: string }>(
  records: readonly T[],
  selectors: readonly string[] | undefined,
  label: string,
): readonly T[] {
  if (records.length === 0) throw new Error(`No discovered Agent ${label} files found.`);
  if (!selectors || selectors.length === 0 || selectors.includes('all')) return records;
  return selectors.map((selector) => selectDiscoveredRecord(records, selector, label));
}

function discoveredSkillToTemplate(skill: SkillRecord): AgentRuntimeProfileStarterTemplate['skills'][number] {
  if (!skill.body.trim()) throw new Error(`Discovered Agent skill ${skill.name} has no procedure body.`);
  assertNoSecretLikeText([skill.name, skill.description, skill.body], `Discovered skill '${skill.name}'`);
  return {
    name: skill.name,
    description: skill.description || `Imported skill from ${skill.origin} skill file.`,
    procedure: skill.body,
    triggers: splitFrontmatterList(skill.frontmatter.triggers),
    tags: splitFrontmatterList(skill.frontmatter.tags),
  };
}

function discoveredRoutineToTemplate(routine: DiscoveredRoutineRecord): AgentRuntimeProfileStarterTemplate['routines'][number] {
  if (!routine.steps.trim()) throw new Error(`Discovered Agent routine ${routine.name} has no steps.`);
  assertNoSecretLikeText([routine.name, routine.description, routine.steps], `Discovered routine '${routine.name}'`);
  return {
    name: routine.name,
    description: routine.description || `Imported routine from ${routine.origin} markdown file.`,
    steps: routine.steps,
    triggers: splitFrontmatterList(routine.frontmatter.triggers),
    tags: splitFrontmatterList(routine.frontmatter.tags),
  };
}

function discoveredPersonaToTemplate(persona: DiscoveredPersonaRecord): AgentRuntimeProfileStarterTemplate['persona'] {
  assertNoSecretLikeText([persona.name, persona.description, persona.body], `Discovered persona '${persona.name}'`);
  return {
    name: persona.name,
    description: persona.description || `Imported persona from ${persona.origin} markdown file.`,
    body: persona.body,
    tags: splitFrontmatterList(persona.frontmatter.tags),
    triggers: splitFrontmatterList(persona.frontmatter.triggers),
  };
}

function readTemplateTextBlock(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Starter template ${field} is required.`);
  return value.trim();
}

function readTemplateObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Starter template ${field} must be an object.`);
  return value;
}

function parseTemplateSkill(value: unknown): AgentRuntimeProfileStarterTemplate['skills'][number] {
  const record = readTemplateObject(value, 'skill');
  return {
    name: readTemplateTextBlock(record.name, 'skill.name'),
    description: readTemplateTextBlock(record.description, 'skill.description'),
    procedure: readTemplateTextBlock(record.procedure, 'skill.procedure'),
    triggers: parseStringArray(record.triggers),
    tags: parseStringArray(record.tags),
  };
}

function parseTemplateRoutine(value: unknown): AgentRuntimeProfileStarterTemplate['routines'][number] {
  const record = readTemplateObject(value, 'routine');
  return {
    name: readTemplateTextBlock(record.name, 'routine.name'),
    description: readTemplateTextBlock(record.description, 'routine.description'),
    steps: readTemplateTextBlock(record.steps, 'routine.steps'),
    triggers: parseStringArray(record.triggers),
    tags: parseStringArray(record.tags),
  };
}

function parseTemplateVibe(value: unknown): AgentRuntimeProfileStarterTemplate['vibe'] | undefined {
  if (value === undefined || value === null) return undefined;
  const record = readTemplateObject(value, 'vibe');
  const body = readTemplateTextBlock(record.body, 'vibe.body');
  assertNoSecretLikeText([body], 'Agent starter VIBE.md');
  const source = record.source === 'template' ? 'template' : 'discovered';
  const appliedAs = record.appliedAs === 'global' ? 'global' : 'global';
  const truncated = typeof record.truncated === 'number' && Number.isFinite(record.truncated)
    ? Math.max(0, Math.trunc(record.truncated))
    : 0;
  return {
    body,
    source,
    appliedAs,
    sourcePaths: parseStringArray(record.sourcePaths),
    truncated,
  };
}

function profileTemplateVibeShellPaths(shellPaths: AgentRuntimeProfileTemplateShellPaths): Parameters<typeof discoverVibeFiles>[0] {
  return {
    homeDirectory: shellPaths.homeDirectory,
    workingDirectory: shellPaths.workingDirectory,
    resolveUserPath: shellPaths.resolveUserPath ?? ((...parts: string[]) => join(shellPaths.homeDirectory, '.goodvibes', ...parts)),
    expandHomePath: shellPaths.expandHomePath ?? ((value: string) => value.startsWith('~/') ? join(shellPaths.homeDirectory, value.slice(2)) : value),
    resolveWorkspacePath: shellPaths.resolveWorkspacePath ?? ((value: string) => {
      const expanded = value.startsWith('~/') ? join(shellPaths.homeDirectory, value.slice(2)) : value;
      return isAbsolute(expanded) ? resolve(expanded) : resolve(shellPaths.workingDirectory, expanded);
    }),
  };
}

function discoveredVibeToTemplate(
  shellPaths: AgentRuntimeProfileTemplateExportOptions['shellPaths'],
): AgentRuntimeProfileStarterTemplate['vibe'] | undefined {
  if (!shellPaths) throw new Error('Including VIBE.md in a starter template requires shell path context.');
  const snapshot = discoverVibeFiles(profileTemplateVibeShellPaths(shellPaths));
  if (snapshot.blocked.length > 0) {
    throw new Error(`Cannot include VIBE.md in a starter template while ${snapshot.blocked.length} VIBE.md file is blocked. Look at the VIBE.md files (Memory and knowledge, Personas) and repair it first.`);
  }
  if (snapshot.files.length === 0) return undefined;
  const body = snapshot.files.map((file) => [
    `## ${file.scope === 'global' ? 'Global' : 'Project'} VIBE.md`,
    `Source: ${file.path}`,
    '',
    file.body,
    file.truncated ? '[This VIBE.md was truncated before profile starter export.]' : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  assertNoSecretLikeText([body], 'Agent starter VIBE.md');
  return {
    body,
    source: 'discovered',
    appliedAs: 'global',
    sourcePaths: snapshot.files.map((file) => file.path),
    truncated: snapshot.files.filter((file) => file.truncated).length,
  };
}

function withOptionalVibe(
  template: AgentRuntimeProfileStarterTemplate,
  options: AgentRuntimeProfileTemplateExportOptions | undefined,
): AgentRuntimeProfileStarterTemplate {
  if (options?.includeVibe !== true) return template;
  const vibe = discoveredVibeToTemplate(options.shellPaths);
  return vibe ? { ...template, vibe } : template;
}

function parseStarterTemplate(raw: unknown, source: AgentRuntimeProfileTemplateSource, path?: string): AgentRuntimeProfileStarterTemplate {
  const file = readTemplateObject(raw, 'file');
  const templateRecord = readTemplateObject(file.template ?? raw, 'template');
  const id = assertValidAgentRuntimeProfileId(readTemplateTextBlock(templateRecord.id, 'id'));
  const personaRecord = readTemplateObject(templateRecord.persona, 'persona');
  const skills = Array.isArray(templateRecord.skills) ? templateRecord.skills.map(parseTemplateSkill) : [];
  const routines = Array.isArray(templateRecord.routines) ? templateRecord.routines.map(parseTemplateRoutine) : [];
  const vibe = parseTemplateVibe(templateRecord.vibe);
  if (skills.length === 0) throw new Error(`Starter template ${id} must include at least one skill.`);
  if (routines.length === 0) throw new Error(`Starter template ${id} must include at least one routine.`);
  const persona = {
    name: readTemplateTextBlock(personaRecord.name, 'persona.name'),
    description: readTemplateTextBlock(personaRecord.description, 'persona.description'),
    body: readTemplateTextBlock(personaRecord.body, 'persona.body'),
    tags: parseStringArray(personaRecord.tags),
    triggers: parseStringArray(personaRecord.triggers),
  };
  return {
    id,
    source,
    path,
    name: readTemplateTextBlock(templateRecord.name, 'name'),
    description: readTemplateTextBlock(templateRecord.description, 'description'),
    personaName: typeof templateRecord.personaName === 'string' && templateRecord.personaName.trim() ? templateRecord.personaName.trim() : persona.name,
    skillNames: skills.map((skill) => skill.name),
    routineNames: routines.map((routine) => routine.name),
    persona,
    skills,
    routines,
    ...(vibe ? { vibe: { ...vibe, source: 'template' } } : {}),
  };
}

function readLocalTemplate(path: string): AgentRuntimeProfileStarterTemplate | null {
  try {
    return parseStarterTemplate(JSON.parse(readFileSync(path, 'utf-8')), 'local', path);
  } catch (error) {
    logger.warn('Agent starter template file could not be read and is left out of the template list', {
      path,
      error: summarizeError(error),
    });
    return null;
  }
}

/** Why a local template file that exists cannot be used, or null when there is none or it is fine. */
function localTemplateProblem(baseHomeDirectory: string, id: string): string | null {
  const path = join(getAgentRuntimeProfileTemplatesRoot(baseHomeDirectory), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    parseStarterTemplate(JSON.parse(readFileSync(path, 'utf-8')), 'local', path);
    return null;
  } catch (error) {
    return `${path} could not be read as a starter template: ${summarizeError(error)}`;
  }
}

function assertNotBuiltinTemplateId(id: string, action: string): void {
  if (STARTER_TEMPLATES.some((template) => template.id === id)) {
    throw new Error(`Cannot ${action} a starter template named ${id}: that is a built-in template and always takes precedence. Choose a different id.`);
  }
}

function listLocalTemplates(baseHomeDirectory: string): readonly AgentRuntimeProfileStarterTemplate[] {
  const root = getAgentRuntimeProfileTemplatesRoot(baseHomeDirectory);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readLocalTemplate(join(root, entry)))
    .filter((entry): entry is AgentRuntimeProfileStarterTemplate => entry !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function resolveAgentRuntimeProfileTemplate(templateId: AgentRuntimeProfileTemplateId, baseHomeDirectory?: string): AgentRuntimeProfileStarterTemplate {
  const id = assertValidAgentRuntimeProfileId(templateId);
  const builtin = STARTER_TEMPLATES.find((template) => template.id === id);
  if (builtin) return builtin;
  const local = baseHomeDirectory ? listLocalTemplates(baseHomeDirectory).find((template) => template.id === id) : undefined;
  if (local) return local;
  const problem = baseHomeDirectory ? localTemplateProblem(baseHomeDirectory, id) : null;
  if (problem) throw new Error(`Agent starter profile template ${templateId} is unusable: ${problem}`);
  const suffix = baseHomeDirectory ? ' Use profiles templates to list starters.' : '';
  throw new AgentProfileUsageError(`Unknown Agent starter profile template ${templateId}.${suffix}`);
}

export function listAgentRuntimeProfileTemplates(baseHomeDirectory?: string): readonly AgentRuntimeProfileTemplateSummary[] {
  const builtins = STARTER_TEMPLATES.map(summarizeTemplate);
  const locals = baseHomeDirectory ? listLocalTemplates(baseHomeDirectory).map(summarizeTemplate) : [];
  return [...builtins, ...locals];
}

export function getAgentRuntimeProfileTemplate(templateId: AgentRuntimeProfileTemplateId, baseHomeDirectory?: string): AgentRuntimeProfileTemplateSummary {
  return summarizeTemplate(resolveAgentRuntimeProfileTemplate(templateId, baseHomeDirectory));
}

export function getAgentRuntimeProfileTemplateFile(templateId: AgentRuntimeProfileTemplateId, baseHomeDirectory?: string): AgentRuntimeProfileStarterTemplateFile {
  return templateFilePayload(resolveAgentRuntimeProfileTemplate(templateId, baseHomeDirectory));
}

function templateFilePayload(template: AgentRuntimeProfileStarterTemplate): AgentRuntimeProfileStarterTemplateFile {
  return {
    version: 1,
    template: {
      ...template,
      source: 'local',
      path: undefined,
    },
  };
}

export function exportAgentRuntimeProfileTemplate(
  baseHomeDirectory: string,
  templateId: AgentRuntimeProfileTemplateId,
  outputPath: string,
  options: AgentRuntimeProfileTemplateExportOptions = {},
): AgentRuntimeProfileTemplateSummary {
  const template = withOptionalVibe(resolveAgentRuntimeProfileTemplate(templateId, baseHomeDirectory), options);
  const target = outputPath.trim();
  if (!target) throw new Error('Template export path is required.');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(templateFilePayload(template), null, 2)}\n`, 'utf-8');
  return { ...summarizeTemplate(template), path: target };
}

export function importAgentRuntimeProfileTemplate(
  baseHomeDirectory: string,
  sourcePath: string,
  options: { readonly replace?: boolean } = {},
): AgentRuntimeProfileTemplateSummary {
  const source = sourcePath.trim();
  if (!source) throw new Error('Template import path is required.');
  const parsed = parseStarterTemplate(JSON.parse(readFileSync(source, 'utf-8')), 'local');
  assertNotBuiltinTemplateId(parsed.id, 'import');
  const root = getAgentRuntimeProfileTemplatesRoot(baseHomeDirectory);
  mkdirSync(root, { recursive: true });
  const target = join(root, `${parsed.id}.json`);
  if (existsSync(target) && options.replace !== true) {
    throw new Error(`Agent starter template ${parsed.id} already exists at ${target}; importing would overwrite it. Pass --replace to overwrite it, or delete that file first.`);
  }
  writeFileSync(target, `${JSON.stringify(templateFilePayload({ ...parsed, source: 'local', path: target }), null, 2)}\n`, 'utf-8');
  return summarizeTemplate({ ...parsed, source: 'local', path: target });
}

export async function createAgentRuntimeProfileTemplateFromDiscovered(
  shellPaths: Pick<ShellPathService, 'homeDirectory' | 'workingDirectory'>,
  options: CreateAgentRuntimeProfileTemplateFromDiscoveredOptions,
): Promise<AgentRuntimeProfileTemplateSummary> {
  const id = assertValidAgentRuntimeProfileId(options.id);
  assertNotBuiltinTemplateId(id, 'create');
  const [personas, skills, routines] = await Promise.all([
    discoverPersonas(shellPaths),
    discoverSkills(shellPaths),
    discoverRoutines(shellPaths),
  ]);
  const selectedPersona = selectDiscoveredRecord(personas, options.persona, 'persona');
  const selectedSkills = selectDiscoveredRecords(skills, options.skills, 'skill');
  const selectedRoutines = selectDiscoveredRecords(routines, options.routines, 'routine');
  const target = join(getAgentRuntimeProfileTemplatesRoot(shellPaths.homeDirectory), `${id}.json`);
  if (existsSync(target) && options.replace !== true) {
    throw new Error(`Agent starter template already exists ${id}. Rerun with --replace to overwrite it.`);
  }
  const persona = discoveredPersonaToTemplate(selectedPersona);
  const vibe = options.includeVibe ? discoveredVibeToTemplate(shellPaths) : undefined;
  const template: AgentRuntimeProfileStarterTemplate = {
    id,
    source: 'local',
    path: target,
    name: options.name?.trim() || `${persona.name} Starter`,
    description: options.description?.trim() || 'Agent starter template assembled from discovered local persona, skill, and routine files.',
    personaName: persona.name,
    skillNames: selectedSkills.map((skill) => skill.name),
    routineNames: selectedRoutines.map((routine) => routine.name),
    persona,
    skills: selectedSkills.map(discoveredSkillToTemplate),
    routines: selectedRoutines.map(discoveredRoutineToTemplate),
    ...(vibe ? { vibe } : {}),
  };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(templateFilePayload(template), null, 2)}\n`, 'utf-8');
  return summarizeTemplate(template);
}

export async function createAgentRuntimeProfileFromDiscovered(
  shellPaths: Pick<ShellPathService, 'homeDirectory' | 'workingDirectory'>,
  options: CreateAgentRuntimeProfileFromDiscoveredOptions,
): Promise<{
  readonly profile: AgentRuntimeProfileInfo;
  readonly template: AgentRuntimeProfileTemplateSummary;
}> {
  const profileId = assertValidAgentRuntimeProfileId(options.profileName);
  const resolution = resolveAgentRuntimeProfileHome(shellPaths.homeDirectory, profileId);
  if (existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile already exists: ${resolution.id}`);
  }
  const templateId = assertValidAgentRuntimeProfileId(options.templateId ?? profileId);
  const templatePath = join(getAgentRuntimeProfileTemplatesRoot(shellPaths.homeDirectory), `${templateId}.json`);
  const templateExisted = existsSync(templatePath);
  const template = await createAgentRuntimeProfileTemplateFromDiscovered(shellPaths, {
    id: templateId,
    name: options.name,
    description: options.description,
    persona: options.persona,
    skills: options.skills,
    routines: options.routines,
    includeVibe: options.includeVibe,
    replace: options.replace,
  });
  let profile: AgentRuntimeProfileInfo;
  try {
    profile = createAgentRuntimeProfile(shellPaths.homeDirectory, profileId, { templateId: template.id });
  } catch (error) {
    // The template was written only to build this profile; leaving a file the
    // owner never asked to keep would also block a retry under the same id.
    if (!templateExisted) rmSync(templatePath, { force: true });
    throw error;
  }
  return { profile, template };
}

function createMissingSkill(registry: AgentSkillRegistry, template: AgentRuntimeProfileStarterTemplate['skills'][number], reviewed: boolean): string {
  const existing = registry.get(template.name);
  if (existing) return existing.id;
  return registry.create({
    name: template.name,
    description: template.description,
    procedure: template.procedure,
    triggers: template.triggers,
    tags: template.tags,
    enabled: true,
    source: 'system',
    provenance: `goodvibes-agent starter:${template.name}`,
  }, { reviewed }).id;
}

function createMissingRoutine(registry: AgentRoutineRegistry, template: AgentRuntimeProfileStarterTemplate['routines'][number], reviewed: boolean): string {
  const existing = registry.get(template.name);
  if (existing) return existing.id;
  return registry.create({
    name: template.name,
    description: template.description,
    steps: template.steps,
    triggers: template.triggers,
    tags: template.tags,
    enabled: true,
    source: 'system',
    provenance: `goodvibes-agent starter:${template.name}`,
  }, { reviewed }).id;
}

/**
 * Write the template's VIBE text. A reviewed (built-in) template's goes live as
 * VIBE.md; any other is written beside it as VIBE.md.pending, which no prompt
 * reads, until the person reviews it and renames it.
 */
function writeTemplateVibe(homeDirectory: string, template: AgentRuntimeProfileStarterTemplate, reviewed: boolean): string | undefined {
  if (!template.vibe?.body.trim()) return undefined;
  assertNoSecretLikeText([template.vibe.body], 'Agent starter VIBE.md');
  const path = join(homeDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, reviewed ? 'VIBE.md' : 'VIBE.md.pending');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${template.vibe.body.trimEnd()}\n`, 'utf-8');
  return path;
}

export function applyAgentRuntimeProfileTemplate(homeDirectory: string, templateId: AgentRuntimeProfileTemplateId, baseHomeDirectory?: string): AgentRuntimeProfileTemplateApplication {
  const template = resolveAgentRuntimeProfileTemplate(templateId, baseHomeDirectory);
  const personaRegistry = new AgentPersonaRegistry(profileStorePath(homeDirectory, 'personas', 'personas.json'));
  // The profile's home's one skill store (the daemon's skill files there), not a file of the Agent's own.
  const skillRegistry = AgentSkillRegistry.forHome(homeDirectory);
  const routineRegistry = new AgentRoutineRegistry(profileStorePath(homeDirectory, 'routines', 'routines.json'));
  // Text shipped in this build needs no review before it applies.
  const reviewed = template.source === 'builtin';
  const existingPersona = personaRegistry.get(template.persona.name);
  const persona = existingPersona ?? personaRegistry.create({
    name: template.persona.name,
    description: template.persona.description,
    body: template.persona.body,
    tags: template.persona.tags,
    triggers: template.persona.triggers,
    source: 'system',
    provenance: `goodvibes-agent starter:${template.name}`,
  }, { reviewed });
  personaRegistry.setActive(persona.id);
  const skillIds = template.skills.map((skill) => createMissingSkill(skillRegistry, skill, reviewed));
  const routineIds = template.routines.map((routine) => createMissingRoutine(routineRegistry, routine, reviewed));
  const vibePath = writeTemplateVibe(homeDirectory, template, reviewed);
  const vibePending = vibePath !== undefined && !reviewed;
  const profile = `goodvibes-agent --agent-profile ${basename(homeDirectory)}`;
  const reviewCommands = [
    ...(personaRegistry.get(persona.id)?.reviewState === 'reviewed' ? [] : [`${profile} personas review ${persona.id}`]),
    ...skillIds.filter((id) => skillRegistry.get(id)?.reviewState !== 'reviewed').map((id) => `${profile} skills review ${id}`),
    ...routineIds.filter((id) => routineRegistry.get(id)?.reviewState !== 'reviewed').map((id) => `${profile} routines review ${id}`),
    ...(vibePending ? [`read ${vibePath}, then rename it to VIBE.md in the same folder to apply it`] : []),
  ];
  return {
    id: template.id,
    name: template.name,
    source: template.source,
    appliedAt: new Date().toISOString(),
    personaIds: [persona.id],
    skillIds,
    routineIds,
    ...(vibePath ? { vibePath } : {}),
    ...(vibePending ? { vibePending } : {}),
    reviewCommands,
  };
}

export function listAgentRuntimeProfiles(baseHomeDirectory: string): readonly AgentRuntimeProfileInfo[] {
  const root = getAgentRuntimeProfilesRoot(baseHomeDirectory);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => PROFILE_ID_PATTERN.test(entry) && !entry.includes('..'))
    .filter((entry) => {
      try {
        return statSync(join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => buildProfileInfo(baseHomeDirectory, entry));
}

export function createAgentRuntimeProfile(baseHomeDirectory: string, profileName: string, options: CreateAgentRuntimeProfileOptions = {}): AgentRuntimeProfileInfo {
  const resolution = resolveAgentRuntimeProfileHome(baseHomeDirectory, profileName);
  if (existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile already exists: ${resolution.id}`);
  }
  // An unknown or unusable template is refused before anything exists on disk.
  if (options.templateId) resolveAgentRuntimeProfileTemplate(options.templateId, baseHomeDirectory);
  mkdirSync(resolution.homeDirectory, { recursive: true });
  const createdAt = new Date().toISOString();
  let appliedTemplate: AgentRuntimeProfileTemplateApplication | undefined;
  try {
    appliedTemplate = options.templateId
      ? applyAgentRuntimeProfileTemplate(resolution.homeDirectory, options.templateId, baseHomeDirectory)
      : undefined;
    writeFileSync(
      join(resolution.homeDirectory, PROFILE_CREATED_FILE),
      `${JSON.stringify({
        id: resolution.id,
        createdAt,
        starterTemplate: appliedTemplate,
      }, null, 2)}\n`,
      'utf-8',
    );
  } catch (error) {
    // The directory did not exist before this call, so removing it restores that
    // state: a half-built profile would be listed, selectable, and would block
    // the retry under the same name.
    rmSync(resolution.homeDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    ...resolution,
    createdAt,
    starterTemplateId: appliedTemplate?.id,
    starterTemplateName: appliedTemplate?.name,
    starterTemplateApplication: appliedTemplate,
  };
}

export function setAgentRuntimeProfileSelection(baseHomeDirectory: string, profileName: string): AgentRuntimeProfileSelection {
  const resolution = resolveAgentRuntimeProfileHome(baseHomeDirectory, profileName);
  if (!existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile not found ${resolution.id}`);
  }
  const path = getAgentRuntimeProfileSelectionPath(baseHomeDirectory);
  mkdirSync(dirname(path), { recursive: true });
  const selectedAt = new Date().toISOString();
  writeFileSync(
    path,
    `${JSON.stringify({
      profileId: resolution.id,
      selectedAt,
    }, null, 2)}\n`,
    'utf-8',
  );
  return {
    ...resolution,
    selectedAt,
    path,
    exists: true,
  };
}

export function clearAgentRuntimeProfileSelection(baseHomeDirectory: string): boolean {
  const path = getAgentRuntimeProfileSelectionPath(baseHomeDirectory);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function deleteAgentRuntimeProfile(baseHomeDirectory: string, profileName: string): boolean {
  const resolution = resolveAgentRuntimeProfileHome(baseHomeDirectory, profileName);
  if (!existsSync(resolution.homeDirectory)) return false;
  rmSync(resolution.homeDirectory, { recursive: true, force: true });
  const selection = readAgentRuntimeProfileSelection(baseHomeDirectory);
  if (selection?.id === resolution.id) clearAgentRuntimeProfileSelection(baseHomeDirectory);
  return true;
}

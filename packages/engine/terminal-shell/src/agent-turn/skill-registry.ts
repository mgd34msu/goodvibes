import { freshReviewPatch, parseAgentReviewState, reviewedReviewPatch, staleReviewPatch } from './review-state.js';
import {isExecutable as canExecute} from '@goodvibes/engine/terminal-shell/cli-environment';
import { delimiter, join } from 'node:path';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { readJsonStore, runStoreFileUpdateSync, writeJsonStore, type JsonStoreContents, type JsonStoreSpec, type JsonStoreWriteReport, type writeStoreFile } from './store-file.js';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { assertNoSecretLikeText } from './persona-registry.js';
import { parseSkillStandardMarkdown, writeSkillStandardFile } from './skill-standard.js';
import { formatAgentRecordReviewState } from './record-labels.js';
import type {
  AgentSkillBundleCreateInput,
  AgentSkillBundleReadiness,
  AgentSkillBundleRecord,
  AgentSkillBundleUpdateInput,
  AgentSkillCreateInput,
  AgentSkillReadiness,
  AgentSkillRecord,
  AgentSkillRequirement,
  AgentSkillRequirementKind,
  AgentSkillSnapshot,
  AgentSkillUpdateInput,
} from './skill-registry-types.js';
export type {
  AgentSkillBundleCreateInput,
  AgentSkillBundleReadiness,
  AgentSkillBundleRecord,
  AgentSkillBundleUpdateInput,
  AgentSkillCreateInput,
  AgentSkillReadiness,
  AgentSkillRecord,
  AgentSkillRequirement,
  AgentSkillRequirementKind,
  AgentSkillReviewState,
  AgentSkillSnapshot,
  AgentSkillSource,
  AgentSkillUpdateInput,
} from './skill-registry-types.js';

interface SkillStoreFile {
  readonly version: 1;
  readonly skills: readonly AgentSkillRecord[];
  readonly bundles: readonly AgentSkillBundleRecord[];
}

const STORE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function readRequirementKind(value: unknown): AgentSkillRequirementKind | null {
  if (value === 'env' || value === 'command') return value;
  return null;
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Collapse embedded newlines and whitespace runs so a description is always a single line. */
function normalizeDescription(description: string): string {
  return description.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function validateRequirementName(requirement: AgentSkillRequirement): void {
  if (requirement.kind === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(requirement.name)) {
    throw new Error(`Invalid skill env requirement ${requirement.name}`);
  }
  if (requirement.kind === 'command' && !/^[A-Za-z0-9._+-]+$/.test(requirement.name)) {
    throw new Error(`Invalid skill command requirement ${requirement.name}`);
  }
}

function normalizeRequirements(values: readonly AgentSkillRequirement[] | undefined): AgentSkillRequirement[] {
  const seen = new Set<string>();
  const result: AgentSkillRequirement[] = [];
  for (const value of values ?? []) {
    const kind = readRequirementKind(value.kind);
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!kind || !name) continue;
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    const requirement: AgentSkillRequirement = {
      kind,
      name,
      ...(description ? { description } : {}),
    };
    validateRequirementName(requirement);
    const key = `${requirement.kind}:${requirement.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(requirement);
  }
  return result;
}

function parseRequirements(value: unknown): AgentSkillRequirement[] {
  if (!Array.isArray(value)) return [];
  return normalizeRequirements(value
    .filter(isRecord)
    .map((entry) => ({
      kind: readRequirementKind(entry.kind) ?? 'env',
      name: readString(entry.name).trim(),
      description: readString(entry.description).trim(),
    })));
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

function nowIso(): string {
  return new Date().toISOString();
}



function commandExists(command: string, pathValue: string | undefined): boolean {
  if (!pathValue) return false;
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((pathEntry) => canExecute(join(pathEntry, command)));
}

function parseSkill(value: unknown): AgentSkillRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const name = normalizeName(readString(value.name));
  const description = readString(value.description).trim();
  const procedure = readString(value.procedure).trim();
  if (!id || !name || !description || !procedure) return null;
  const reviewState = parseAgentReviewState(value.reviewState);
  const source = value.source === 'agent' || value.source === 'imported' || value.source === 'system' ? value.source : 'user';
  const staleReason = readString(value.staleReason).trim();
  const reviewedAt = readString(value.reviewedAt).trim();
  return {
    id,
    name,
    description,
    procedure,
    triggers: readStringArray(value.triggers),
    tags: readStringArray(value.tags),
    requirements: parseRequirements(value.requirements),
    enabled: value.enabled === true,
    source,
    provenance: readString(value.provenance, source).trim() || source,
    reviewState,
    staleReason: staleReason || undefined,
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
    reviewedAt: reviewedAt || undefined,
  };
}

function parseBundle(value: unknown): AgentSkillBundleRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const name = normalizeName(readString(value.name));
  const description = readString(value.description).trim();
  const skillIds = readStringArray(value.skillIds).map(slugify).filter(Boolean);
  if (!id || !name || !description || skillIds.length === 0) return null;
  const reviewState = parseAgentReviewState(value.reviewState);
  const source = value.source === 'agent' || value.source === 'imported' || value.source === 'system' ? value.source : 'user';
  const staleReason = readString(value.staleReason).trim();
  const reviewedAt = readString(value.reviewedAt).trim();
  return {
    id,
    name,
    description,
    skillIds: normalizeList(skillIds).map(slugify),
    enabled: value.enabled === true,
    source,
    provenance: readString(value.provenance, source).trim() || source,
    reviewState,
    staleReason: staleReason || undefined,
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
    reviewedAt: reviewedAt || undefined,
  };
}

const SKILL_STORE: JsonStoreSpec<AgentSkillRecord> = {
  label: 'skill store',
  entriesKey: 'skills',
  version: STORE_VERSION,
  parseEntry: parseSkill,
};

/** Bundles live beside the skills; one this build cannot read is kept as found, like a skill. */
function readBundles(contents: JsonStoreContents<AgentSkillRecord>): { readonly bundles: AgentSkillBundleRecord[]; readonly keptAsFound: unknown[] } {
  const raw = contents.fields.bundles;
  const bundles: AgentSkillBundleRecord[] = [];
  const keptAsFound: unknown[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const bundle = parseBundle(value);
      if (bundle) bundles.push(bundle);
      else keptAsFound.push(value);
    }
  }
  return { bundles, keptAsFound };
}

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'>;

export function skillStorePath(shellPaths: AgentLocalStorePaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'skills', 'skills.json');
}

export class AgentSkillRegistry {
  private held: JsonStoreContents<AgentSkillRecord> | null = null;
  private lastWrite: JsonStoreWriteReport | undefined;

  public constructor(private readonly storePath: string, private readonly effects?: Parameters<typeof writeStoreFile>[2]) {}

  public static fromShellPaths(shellPaths: AgentLocalStorePaths, effects?: Parameters<typeof writeStoreFile>[2]): AgentSkillRegistry {
    return new AgentSkillRegistry(skillStorePath(shellPaths), effects);
  }

  public snapshot(): AgentSkillSnapshot {
    const store = this.readStore();
    const enabledBundles = store.bundles.filter((bundle) => bundle.enabled);
    const activeSkillIds = new Set<string>(store.skills.filter((skill) => skill.enabled).map((skill) => skill.id));
    for (const bundle of enabledBundles) {
      for (const skillId of bundle.skillIds) activeSkillIds.add(skillId);
    }
    return {
      path: this.storePath,
      skills: [...store.skills],
      enabledSkills: store.skills.filter((skill) => skill.enabled),
      bundles: [...store.bundles],
      enabledBundles,
      activeSkills: store.skills.filter((skill) => activeSkillIds.has(skill.id)),
    };
  }

  public list(): readonly AgentSkillRecord[] {
    return this.snapshot().skills;
  }

  public search(query: string): readonly AgentSkillRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((skill) => [
      skill.id,
      skill.name,
      skill.description,
      skill.procedure,
      ...skill.tags,
      ...skill.triggers,
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  public listBundles(): readonly AgentSkillBundleRecord[] {
    return this.snapshot().bundles;
  }

  public searchBundles(query: string): readonly AgentSkillBundleRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.listBundles();
    return this.listBundles().filter((bundle) => [
      bundle.id,
      bundle.name,
      bundle.description,
      ...bundle.skillIds,
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  public get(idOrName: string): AgentSkillRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((skill) => skill.id.toLowerCase() === lookup || skill.name.toLowerCase() === lookup) ?? null;
  }

  public getBundle(idOrName: string): AgentSkillBundleRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return this.listBundles().find((bundle) => bundle.id.toLowerCase() === lookup || bundle.name.toLowerCase() === lookup) ?? null;
  }

  /**
   * `reviewed`: trusted callers only, for text shipped in this build (a
   * built-in profile starter); everything else starts fresh and waits for review.
   */
  public create(input: AgentSkillCreateInput, options: { readonly reviewed?: boolean } = {}): AgentSkillRecord {
    return this.locked(() => {
      const store = this.readStore();
      const name = normalizeName(input.name);
      const description = normalizeDescription(input.description);
      const procedure = input.procedure.trim();
      this.validateRequired(name, description, procedure);
      const requirements = normalizeRequirements(input.requirements);
      assertNoSecretLikeText([name, description, procedure, ...(input.tags ?? []), ...(input.triggers ?? []), ...requirements.flatMap((requirement) => [requirement.name, requirement.description ?? ''])], 'Skills');
      const duplicate = store.skills.find((skill) => skill.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Skill already exists ${duplicate.id}`);
      const timestamp = nowIso();
      const skill: AgentSkillRecord = {
        id: this.nextId(name, store.skills),
        name,
        description,
        procedure,
        triggers: normalizeList(input.triggers),
        tags: normalizeList(input.tags),
        requirements,
        enabled: input.enabled === true,
        source: input.source ?? 'user',
        provenance: input.provenance?.trim() || input.source || 'user',
        ...(options.reviewed ? reviewedReviewPatch() : { reviewState: 'fresh' as const }),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.writeStore({ ...store, skills: [...store.skills, skill] });
      return skill;
    });
  }

  public createBundle(input: AgentSkillBundleCreateInput): AgentSkillBundleRecord {
    return this.locked(() => {
      const store = this.readStore();
      const name = normalizeName(input.name);
      const description = input.description.trim();
      const skillIds = this.normalizeExistingSkillIds(store, input.skillIds);
      this.validateBundleRequired(name, description, skillIds);
      assertNoSecretLikeText([name, description, ...skillIds], 'Skill bundles');
      const duplicate = store.bundles.find((bundle) => bundle.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Skill bundle already exists ${duplicate.id}`);
      const timestamp = nowIso();
      const bundle: AgentSkillBundleRecord = {
        id: this.nextBundleId(name, store.bundles),
        name,
        description,
        skillIds,
        enabled: input.enabled === true,
        source: input.source ?? 'user',
        provenance: input.provenance?.trim() || input.source || 'user',
        reviewState: 'fresh',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.writeStore({ ...store, bundles: [...store.bundles, bundle] });
      return bundle;
    });
  }

  public update(idOrName: string, input: AgentSkillUpdateInput): AgentSkillRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill ${idOrName}`);
      const name = input.name === undefined ? existing.name : normalizeName(input.name);
      const description = input.description === undefined ? existing.description : input.description.trim();
      const procedure = input.procedure === undefined ? existing.procedure : input.procedure.trim();
      this.validateRequired(name, description, procedure);
      const requirements = input.requirements === undefined ? existing.requirements : normalizeRequirements(input.requirements);
      assertNoSecretLikeText([name, description, procedure, ...(input.tags ?? []), ...(input.triggers ?? []), ...requirements.flatMap((requirement) => [requirement.name, requirement.description ?? ''])], 'Skills');
      const duplicate = store.skills.find((skill) => skill.id !== existing.id && skill.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Skill already exists ${duplicate.id}`);
      const updated: AgentSkillRecord = {
        ...existing,
        name,
        description,
        procedure,
        triggers: input.triggers === undefined ? existing.triggers : normalizeList(input.triggers),
        tags: input.tags === undefined ? existing.tags : normalizeList(input.tags),
        requirements,
        enabled: input.enabled ?? existing.enabled,
        provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
        ...freshReviewPatch(),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        skills: store.skills.map((skill) => skill.id === existing.id ? updated : skill),
      });
      return updated;
    });
  }

  public updateBundle(idOrName: string, input: AgentSkillBundleUpdateInput): AgentSkillBundleRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findBundleInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill bundle ${idOrName}`);
      const name = input.name === undefined ? existing.name : normalizeName(input.name);
      const description = input.description === undefined ? existing.description : input.description.trim();
      const skillIds = input.skillIds === undefined ? existing.skillIds : this.normalizeExistingSkillIds(store, input.skillIds);
      this.validateBundleRequired(name, description, skillIds);
      assertNoSecretLikeText([name, description, ...skillIds], 'Skill bundles');
      const duplicate = store.bundles.find((bundle) => bundle.id !== existing.id && bundle.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Skill bundle already exists ${duplicate.id}`);
      const updated: AgentSkillBundleRecord = {
        ...existing,
        name,
        description,
        skillIds,
        enabled: input.enabled ?? existing.enabled,
        provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
        ...freshReviewPatch(),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        bundles: store.bundles.map((bundle) => bundle.id === existing.id ? updated : bundle),
      });
      return updated;
    });
  }

  public setEnabled(idOrName: string, enabled: boolean): AgentSkillRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill ${idOrName}`);
      const updated: AgentSkillRecord = { ...existing, enabled, updatedAt: nowIso() };
      this.writeStore({
        ...store,
        skills: store.skills.map((skill) => skill.id === existing.id ? updated : skill),
      });
      return updated;
    });
  }

  public setBundleEnabled(idOrName: string, enabled: boolean): AgentSkillBundleRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findBundleInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill bundle ${idOrName}`);
      const updated: AgentSkillBundleRecord = { ...existing, enabled, updatedAt: nowIso() };
      this.writeStore({
        ...store,
        bundles: store.bundles.map((bundle) => bundle.id === existing.id ? updated : bundle),
      });
      return updated;
    });
  }

  public markReviewed(idOrName: string): AgentSkillRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill ${idOrName}`);
      const updated: AgentSkillRecord = {
        ...existing,
        ...reviewedReviewPatch(),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        skills: store.skills.map((skill) => skill.id === existing.id ? updated : skill),
      });
      return updated;
    });
  }

  public markBundleReviewed(idOrName: string): AgentSkillBundleRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findBundleInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill bundle ${idOrName}`);
      const updated: AgentSkillBundleRecord = {
        ...existing,
        ...reviewedReviewPatch(),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        bundles: store.bundles.map((bundle) => bundle.id === existing.id ? updated : bundle),
      });
      return updated;
    });
  }

  public markStale(idOrName: string, reason: string): AgentSkillRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill ${idOrName}`);
      const updated: AgentSkillRecord = {
        ...existing,
        ...staleReviewPatch(reason),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        skills: store.skills.map((skill) => skill.id === existing.id ? updated : skill),
      });
      return updated;
    });
  }

  public markBundleStale(idOrName: string, reason: string): AgentSkillBundleRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findBundleInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill bundle ${idOrName}`);
      const updated: AgentSkillBundleRecord = {
        ...existing,
        ...staleReviewPatch(reason),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        bundles: store.bundles.map((bundle) => bundle.id === existing.id ? updated : bundle),
      });
      return updated;
    });
  }

  public deleteSkill(idOrName: string): AgentSkillRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill ${idOrName}`);
      this.writeStore({
        ...store,
        skills: store.skills.filter((skill) => skill.id !== existing.id),
        bundles: store.bundles
          .map((bundle) => ({ ...bundle, skillIds: bundle.skillIds.filter((skillId) => skillId !== existing.id) }))
          .filter((bundle) => bundle.skillIds.length > 0),
      });
      return existing;
    });
  }

  public deleteBundle(idOrName: string): AgentSkillBundleRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findBundleInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown skill bundle ${idOrName}`);
      this.writeStore({
        ...store,
        bundles: store.bundles.filter((bundle) => bundle.id !== existing.id),
      });
      return existing;
    });
  }

  /**
   * Import a skill from the open skill standard format (SKILL.md).
   * The skill is created with provenance 'skill-standard-import' and enabled=false (review-first policy).
   * Throws if the file content is invalid or contains secret-looking text.
   */
  public importFromStandard(content: string): AgentSkillRecord {
    const parsed = parseSkillStandardMarkdown(content);
    if ('error' in parsed) throw new Error(parsed.error);
    return this.create({
      name: parsed.name,
      description: parsed.description,
      procedure: parsed.body,
      enabled: false,
      source: 'imported',
      provenance: 'skill-standard-import',
    });
  }

  /**
   * Export one local skill by id to `<destDir>/<slug>/SKILL.md`.
   * Throws if the skill is not found or the file already exists without overwrite=true.
   * Returns the path written.
   */
  public exportToStandard(idOrName: string, destDir: string, overwrite = false): string {
    const skill = this.get(idOrName);
    if (!skill) throw new Error(`Unknown skill ${idOrName}`);
    return writeSkillStandardFile(skill, destDir, overwrite);
  }

  private validateRequired(name: string, description: string, procedure: string): void {
    if (!name) throw new Error('Skill name is required.');
    if (!description) throw new Error('Skill description is required.');
    if (!procedure) throw new Error('Skill procedure is required.');
  }

  private validateBundleRequired(name: string, description: string, skillIds: readonly string[]): void {
    if (!name) throw new Error('Skill bundle name is required.');
    if (!description) throw new Error('Skill bundle description is required.');
    if (skillIds.length === 0) throw new Error('Skill bundle must include at least one existing skill.');
  }

  private nextId(name: string, skills: readonly AgentSkillRecord[]): string {
    const base = slugify(name);
    const ids = new Set(skills.map((skill) => skill.id));
    if (!ids.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate skill id for ${name}.`);
  }

  private nextBundleId(name: string, bundles: readonly AgentSkillBundleRecord[]): string {
    const base = slugify(name);
    const ids = new Set(bundles.map((bundle) => bundle.id));
    if (!ids.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate skill bundle id for ${name}.`);
  }

  private findInStore(store: SkillStoreFile, idOrName: string): AgentSkillRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return store.skills.find((skill) => skill.id.toLowerCase() === lookup || skill.name.toLowerCase() === lookup) ?? null;
  }

  private findBundleInStore(store: SkillStoreFile, idOrName: string): AgentSkillBundleRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return store.bundles.find((bundle) => bundle.id.toLowerCase() === lookup || bundle.name.toLowerCase() === lookup) ?? null;
  }

  private normalizeExistingSkillIds(store: SkillStoreFile, skillIds: readonly string[]): readonly string[] {
    const normalized = normalizeList(skillIds).map(slugify);
    const known = new Set(store.skills.map((skill) => skill.id));
    for (const skillId of normalized) {
      if (!known.has(skillId)) throw new Error(`Unknown skill for bundle ${skillId}`);
    }
    return normalized;
  }

  /** What the last write reported: skills this version cannot read that were kept, or a copy of an unreadable file. */
  public lastWriteReport(): JsonStoreWriteReport | undefined {
    return this.lastWrite;
  }

  /** A file that is not JSON is reported on a read, never shown as no skills; a save copies it aside first. */
  private readStore(): SkillStoreFile {
    const contents = this.held ?? readJsonStore(this.storePath, SKILL_STORE);
    if (!this.held && contents.unreadable !== undefined) {
      throw new Error(`Could not read Agent skill store at ${this.storePath}: it is ${contents.unreadable}.`);
    }
    return { version: STORE_VERSION, skills: contents.entries, bundles: readBundles(contents).bundles };
  }

  /** One locked read-modify-write; the file is read once and entries this version cannot read are written back as found. */
  private locked<T>(update: () => T): T {
    return runStoreFileUpdateSync(this.storePath, () => {
      this.held = readJsonStore(this.storePath, SKILL_STORE);
      try {
        return update();
      } finally {
        this.held = null;
      }
    });
  }

  private writeStore(store: SkillStoreFile): void {
    const read = this.held ?? readJsonStore(this.storePath, SKILL_STORE);
    const unreadBundles = readBundles(read).keptAsFound;
    this.lastWrite = writeJsonStore(read, SKILL_STORE, {
      entries: store.skills,
      fields: { ...read.fields, bundles: [...store.bundles, ...unreadBundles] },
    }, this.effects);
  }
}

export function buildAgentSkillRequirements(input: {
  readonly env?: readonly string[] | undefined;
  readonly commands?: readonly string[] | undefined;
}): readonly AgentSkillRequirement[] {
  return normalizeRequirements([
    ...(input.env ?? []).map((name) => ({ kind: 'env' as const, name })),
    ...(input.commands ?? []).map((name) => ({ kind: 'command' as const, name })),
  ]);
}

export function normalizeAgentSkillRequirements(values: readonly AgentSkillRequirement[] | undefined): readonly AgentSkillRequirement[] {
  return normalizeRequirements(values);
}

export function formatAgentSkillRequirement(requirement: AgentSkillRequirement): string {
  return `${requirement.kind}:${requirement.name}`;
}

export function evaluateAgentSkillReadiness(
  skill: Pick<AgentSkillRecord, 'requirements'>,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly pathValue?: string | undefined;
  } = {},
): AgentSkillReadiness {
  const env = options.env ?? process.env;
  const pathValue = options.pathValue ?? env.PATH;
  const met: AgentSkillRequirement[] = [];
  const missing: AgentSkillRequirement[] = [];
  for (const requirement of skill.requirements) {
    const present = requirement.kind === 'env'
      ? typeof env[requirement.name] === 'string' && (env[requirement.name] ?? '').length > 0
      : commandExists(requirement.name, pathValue);
    if (present) met.push(requirement);
    else missing.push(requirement);
  }
  return { ready: missing.length === 0, met, missing };
}

export function evaluateAgentSkillBundleReadiness(
  bundle: Pick<AgentSkillBundleRecord, 'skillIds'>,
  skills: readonly AgentSkillRecord[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly pathValue?: string | undefined;
  } = {},
): AgentSkillBundleReadiness {
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const includedSkills: AgentSkillRecord[] = [];
  const missingSkillIds: string[] = [];
  const missingRequirements: AgentSkillRequirement[] = [];
  const seenRequirements = new Set<string>();
  for (const skillId of bundle.skillIds) {
    const skill = skillById.get(skillId);
    if (!skill) {
      missingSkillIds.push(skillId);
      continue;
    }
    includedSkills.push(skill);
    for (const requirement of evaluateAgentSkillReadiness(skill, options).missing) {
      const key = `${requirement.kind}:${requirement.name.toLowerCase()}`;
      if (seenRequirements.has(key)) continue;
      seenRequirements.add(key);
      missingRequirements.push(requirement);
    }
  }
  return {
    ready: missingSkillIds.length === 0 && missingRequirements.length === 0,
    includedSkills,
    missingSkillIds,
    missingRequirements,
  };
}

/**
 * The one-line section that stands in for the skills when the store cannot be
 * read. The turn goes ahead without skills, and the model and owner are told
 * which file to repair rather than every turn failing with no recovery step.
 */
export function skillStoreUnreadableNotice(storePath: string, error: unknown): string {
  return [
    '## Enabled GoodVibes Agent Skills',
    `No skills are applied this turn: the skill store at ${storePath} could not be read (${error instanceof Error ? error.message : String(error)}). Repair or remove that file, then run /my-skills (the Agent) or /skills (the terminal app) to confirm.`,
  ].join('\n');
}

/** How many reviewed, ready skills one prompt carries in full; the receipt counts against the same number. */
export const ENABLED_SKILLS_PROMPT_LIMIT = 8;
/** How many reviewed, ready skill bundles one prompt carries in full. */
export const ENABLED_SKILL_BUNDLES_PROMPT_LIMIT = 4;

/**
 * The line that tells the model which enabled skills the prompt left out, so it
 * can read one by name instead of not knowing it exists. Empty when none were cut.
 */
export function skillsBeyondPromptLimitLine(skills: readonly AgentSkillRecord[], bundles: readonly AgentSkillBundleRecord[]): string {
  const cut = skills.slice(ENABLED_SKILLS_PROMPT_LIMIT);
  const cutBundles = bundles.slice(ENABLED_SKILL_BUNDLES_PROMPT_LIMIT);
  if (cut.length === 0 && cutBundles.length === 0) return '';
  const names = [
    ...cutBundles.map((bundle) => `${bundle.name} (bundle ${bundle.id})`),
    ...cut.map((skill) => `${skill.name} (${skill.id})`),
  ];
  const shown = names.slice(0, 20).join(', ');
  const more = names.length > 20 ? `, and ${names.length - 20} more` : '';
  return `${names.length} more enabled skill${names.length === 1 ? '' : 's'} not shown here: ${shown}${more}. When one fits, read it with agent_local_registry domain:"skill" action:"get" id:<id> (domain:"skill_bundle" for a bundle).`;
}

export function buildEnabledSkillsPrompt(shellPaths: ShellPathService, preread?: AgentSkillSnapshot): string | null {
  const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
  let snapshot: AgentSkillSnapshot;
  try {
    snapshot = preread ?? registry.snapshot();
  } catch (error) {
    logger.warn('Agent skill store could not be read; composing the system prompt without skills', {
      path: skillStorePath(shellPaths),
      error: summarizeError(error),
    });
    return skillStoreUnreadableNotice(skillStorePath(shellPaths), error);
  }
  const enabledBundles = snapshot.enabledBundles.filter((bundle) => {
    if (bundle.reviewState !== 'reviewed') return false;
    const readiness = evaluateAgentSkillBundleReadiness(bundle, snapshot.skills);
    return readiness.ready && readiness.includedSkills.every((skill) => skill.reviewState === 'reviewed');
  });
  const activeSkillIds = new Set([
    ...snapshot.enabledSkills.map((skill) => skill.id),
    ...enabledBundles.flatMap((bundle) => bundle.skillIds),
  ]);
  const active = snapshot.skills.filter((skill) => (
    activeSkillIds.has(skill.id)
    && skill.reviewState === 'reviewed'
    && evaluateAgentSkillReadiness(skill).ready
  ));
  const candidateSkillIds = new Set([
    ...snapshot.enabledSkills.map((skill) => skill.id),
    ...snapshot.enabledBundles.flatMap((bundle) => bundle.skillIds),
  ]);
  const suppressedSkills = snapshot.skills
    .filter((skill) => candidateSkillIds.has(skill.id) && !active.some((activeSkill) => activeSkill.id === skill.id))
    .slice(0, 8)
    .map((skill) => {
      const readiness = evaluateAgentSkillReadiness(skill);
      const review = skill.reviewState === 'reviewed' ? '' : `review=${formatAgentRecordReviewState(skill.reviewState)}`;
      const setup = readiness.ready ? '' : `missing=${readiness.missing.map(formatAgentSkillRequirement).join(', ')}`;
      return `- ${skill.name}: ${[review, setup].filter(Boolean).join('; ')}`;
    });
  const suppressedBundles = snapshot.enabledBundles
    .filter((bundle) => !enabledBundles.some((activeBundle) => activeBundle.id === bundle.id))
    .slice(0, 4)
    .map((bundle) => {
      const readiness = evaluateAgentSkillBundleReadiness(bundle, snapshot.skills);
      const review = bundle.reviewState === 'reviewed' ? '' : `review=${formatAgentRecordReviewState(bundle.reviewState)}`;
      const setup = readiness.ready ? '' : `missing=${[
        ...readiness.missingRequirements.map(formatAgentSkillRequirement),
        ...readiness.missingSkillIds.map((skillId) => `skill:${skillId}`),
      ].join(', ')}`;
      const unreviewedSkills = readiness.includedSkills
        .filter((skill) => skill.reviewState !== 'reviewed')
        .map((skill) => `${skill.id}:${formatAgentRecordReviewState(skill.reviewState)}`);
      const memberReview = unreviewedSkills.length === 0 ? '' : `member-review=${unreviewedSkills.join(', ')}`;
      return `- ${bundle.name}: ${[review, setup, memberReview].filter(Boolean).join('; ')}`;
    });
  if (active.length === 0 && enabledBundles.length === 0 && suppressedSkills.length === 0 && suppressedBundles.length === 0) return null;
  const beyondLimit = skillsBeyondPromptLimitLine(active, enabledBundles);
  return [
    '## Enabled GoodVibes Agent Skills',
    'Use only reviewed, setup-ready local reusable procedures inside the same serial assistant conversation when they fit the user request.',
    '',
    ...enabledBundles.slice(0, ENABLED_SKILL_BUNDLES_PROMPT_LIMIT).flatMap((bundle) => {
      const readiness = evaluateAgentSkillBundleReadiness(bundle, snapshot.skills);
      const missing = [
        ...readiness.missingRequirements.map(formatAgentSkillRequirement),
        ...readiness.missingSkillIds.map((skillId) => `skill:${skillId}`),
      ];
      return [
        `### Skill Bundle: ${bundle.name}`,
        `Description: ${bundle.description}`,
        `Review: ${formatAgentRecordReviewState(bundle.reviewState)}`,
        `Readiness: ${readiness.ready ? 'ready' : `missing ${missing.join(', ')}`}`,
        `Included skills: ${bundle.skillIds.join(', ')}`,
        '',
      ];
    }),
    ...active.slice(0, ENABLED_SKILLS_PROMPT_LIMIT).flatMap((skill) => [
      `### ${skill.name}`,
      `Description: ${skill.description}`,
      `Review: ${formatAgentRecordReviewState(skill.reviewState)}`,
      `Triggers: ${skill.triggers.join(', ') || '(manual)'}`,
      `Readiness: ${evaluateAgentSkillReadiness(skill).ready ? 'ready' : `missing ${evaluateAgentSkillReadiness(skill).missing.map(formatAgentSkillRequirement).join(', ')}`}`,
      skill.procedure,
      '',
    ]),
    ...(beyondLimit ? [beyondLimit, ''] : []),
    ...(suppressedBundles.length > 0 || suppressedSkills.length > 0 ? [
      '### Suppressed Skills Pending Review Or Setup',
      'Do not apply these skills until the user reviews them or resolves setup through the learning curator.',
      ...suppressedBundles,
      ...suppressedSkills,
      '',
    ] : []),
  ].join('\n').trim();
}

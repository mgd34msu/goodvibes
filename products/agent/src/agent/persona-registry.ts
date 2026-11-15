import { freshReviewPatch, parseAgentReviewState, reviewedReviewPatch, staleReviewPatch } from './review-state.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  readJsonStore,
  runStoreFileUpdateSync,
  writeJsonStore,
  type JsonStoreContents,
  type JsonStoreSpec,
  type JsonStoreWriteReport,
  writeStoreFile,
} from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { formatAgentRecordReviewState } from './record-labels.ts';
import { containsSecretLikeText } from './memory-safety.ts';

export type AgentPersonaSource = 'user' | 'agent' | 'imported' | 'system';
export type AgentPersonaReviewState = 'fresh' | 'reviewed' | 'stale';

export interface AgentPersonaRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly triggers: readonly string[];
  readonly source: AgentPersonaSource;
  readonly provenance: string;
  readonly reviewState: AgentPersonaReviewState;
  readonly staleReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string;
}

export interface AgentPersonaCreateInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly triggers?: readonly string[];
  readonly source?: AgentPersonaSource;
  readonly provenance?: string;
}

export interface AgentPersonaUpdateInput {
  readonly name?: string;
  readonly description?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly triggers?: readonly string[];
  readonly provenance?: string;
}

export interface AgentPersonaSnapshot {
  readonly path: string;
  readonly personas: readonly AgentPersonaRecord[];
  readonly activePersonaId: string | null;
  readonly activePersona: AgentPersonaRecord | null;
}

interface PersonaStoreFile {
  readonly version: 1;
  readonly activePersonaId: string | null;
  readonly personas: readonly AgentPersonaRecord[];
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

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
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

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'persona';
}

function nowIso(): string {
  return new Date().toISOString();
}

export function assertNoSecretLikeText(fields: readonly string[], ownerLabel = 'Agent local records'): void {
  if (fields.some((field) => containsSecretLikeText(field))) {
    throw new Error(`${ownerLabel} cannot store secret-looking values. Store a secret reference or remove the sensitive text.`);
  }
}

/**
 * Run one read-modify-write of a store file under the cross-process lock.
 * Taking the lock can create the store's directory and a lock file. A write that
 * runs under an admission watching those directories is told so through
 * `onEffect(false)`, the way it is for its own created parents; otherwise it
 * would read the lock as foreign interference and refuse its own write.
 */
export function runLockedStoreUpdate<T>(path: string, effects: { readonly onEffect?: ((published?: boolean) => void) | undefined } | undefined, update: () => T): T {
  return runStoreFileUpdateSync(path, () => {
    effects?.onEffect?.(false);
    return update();
  });
}

/**
 * A store file is rewritten whole by every save, so a save must not follow a
 * read that silently left something out. Call this on the parsed file before a
 * mutator builds on it: it throws when entries failed their parser (hand edit,
 * newer version) or the file was written by a newer store version, because the
 * save would erase them. Reads stay tolerant; only the write path refuses.
 */
export function assertStoreRewritable(parsed: unknown, key: string, kept: number, supportedVersion: number): void {
  if (!isRecord(parsed)) throw new Error('the store file is not a JSON object; repair or remove it before saving, or a save would replace it.');
  if (typeof parsed.version === 'number' && parsed.version > supportedVersion) {
    throw new Error(`the store file is version ${parsed.version} but this release writes version ${supportedVersion}; upgrade before saving, or a save would drop newer data.`);
  }
  const entries = parsed[key];
  const total = Array.isArray(entries) ? entries.length : 0;
  if (total > kept) {
    throw new Error(`${total - kept} of ${total} stored entries cannot be read by this release; repair or remove them in the store file before saving, or a save would erase them.`);
  }
}

function parsePersona(value: unknown): AgentPersonaRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const name = normalizeName(readString(value.name));
  const description = readString(value.description).trim();
  const body = readString(value.body).trim();
  if (!id || !name || !description || !body) return null;
  const reviewState = parseAgentReviewState(value.reviewState);
  const source = value.source === 'agent' || value.source === 'imported' || value.source === 'system' ? value.source : 'user';
  const staleReason = readString(value.staleReason).trim();
  const reviewedAt = readString(value.reviewedAt).trim();
  return {
    id,
    name,
    description,
    body,
    tags: readStringArray(value.tags),
    triggers: readStringArray(value.triggers),
    source,
    provenance: readString(value.provenance, source).trim() || source,
    reviewState,
    staleReason: staleReason || undefined,
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
    reviewedAt: reviewedAt || undefined,
  };
}

const PERSONA_STORE: JsonStoreSpec<AgentPersonaRecord> = {
  label: 'persona store',
  entriesKey: 'personas',
  version: STORE_VERSION,
  parseEntry: parsePersona,
};

function toPersonaStore(contents: JsonStoreContents<AgentPersonaRecord>): PersonaStoreFile {
  const personas = [...contents.entries];
  const activePersonaId = readString(contents.fields.activePersonaId).trim() || null;
  return {
    version: STORE_VERSION,
    activePersonaId: activePersonaId && personas.some((persona) => persona.id === activePersonaId) ? activePersonaId : null,
    personas,
  };
}

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'>;

export function personaStorePath(shellPaths: AgentLocalStorePaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'personas', 'personas.json');
}

export class AgentPersonaRegistry {
  private held: JsonStoreContents<AgentPersonaRecord> | null = null;
  private lastWrite: JsonStoreWriteReport | undefined;

  public constructor(private readonly storePath: string, private readonly effects?: Parameters<typeof writeStoreFile>[2]) {}

  public static fromShellPaths(shellPaths: AgentLocalStorePaths, effects?: Parameters<typeof writeStoreFile>[2]): AgentPersonaRegistry {
    return new AgentPersonaRegistry(personaStorePath(shellPaths), effects);
  }

  public snapshot(): AgentPersonaSnapshot {
    const store = this.readStore();
    const activePersona = store.activePersonaId
      ? store.personas.find((persona) => persona.id === store.activePersonaId) ?? null
      : null;
    return {
      path: this.storePath,
      personas: [...store.personas],
      activePersonaId: activePersona?.id ?? null,
      activePersona,
    };
  }

  public list(): readonly AgentPersonaRecord[] {
    return this.snapshot().personas;
  }

  public search(query: string): readonly AgentPersonaRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((persona) => [
      persona.id,
      persona.name,
      persona.description,
      persona.body,
      ...persona.tags,
      ...persona.triggers,
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  public get(idOrName: string): AgentPersonaRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((persona) => persona.id.toLowerCase() === lookup || persona.name.toLowerCase() === lookup) ?? null;
  }

  public create(input: AgentPersonaCreateInput): AgentPersonaRecord {
    return this.locked(() => {
      const store = this.readStore();
      const name = normalizeName(input.name);
      const description = input.description.trim();
      const body = input.body.trim();
      this.validateRequired(name, description, body);
      assertNoSecretLikeText([name, description, body, ...(input.tags ?? []), ...(input.triggers ?? [])], 'Personas');
      const duplicate = store.personas.find((persona) => persona.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Persona already exists ${duplicate.id}`);
      const timestamp = nowIso();
      const persona: AgentPersonaRecord = {
        id: this.nextId(name, store.personas),
        name,
        description,
        body,
        tags: normalizeList(input.tags),
        triggers: normalizeList(input.triggers),
        source: input.source ?? 'user',
        provenance: input.provenance?.trim() || input.source || 'user',
        reviewState: 'fresh',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.writeStore({ ...store, personas: [...store.personas, persona] });
      return persona;
    });
  }

  public update(idOrName: string, input: AgentPersonaUpdateInput): AgentPersonaRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown persona ${idOrName}`);
      const name = input.name === undefined ? existing.name : normalizeName(input.name);
      const description = input.description === undefined ? existing.description : input.description.trim();
      const body = input.body === undefined ? existing.body : input.body.trim();
      this.validateRequired(name, description, body);
      assertNoSecretLikeText([name, description, body, ...(input.tags ?? []), ...(input.triggers ?? [])], 'Personas');
      const duplicate = store.personas.find((persona) => persona.id !== existing.id && persona.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`Persona already exists ${duplicate.id}`);
      const updated: AgentPersonaRecord = {
        ...existing,
        name,
        description,
        body,
        tags: input.tags === undefined ? existing.tags : normalizeList(input.tags),
        triggers: input.triggers === undefined ? existing.triggers : normalizeList(input.triggers),
        provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
        ...freshReviewPatch(),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        personas: store.personas.map((persona) => persona.id === existing.id ? updated : persona),
      });
      return updated;
    });
  }

  public setActive(idOrName: string): AgentPersonaRecord {
    return this.locked(() => {
      const store = this.readStore();
      const persona = this.findInStore(store, idOrName);
      if (!persona) throw new Error(`Unknown persona ${idOrName}`);
      this.writeStore({ ...store, activePersonaId: persona.id });
      return persona;
    });
  }

  public clearActive(): void {
    return this.locked(() => {
      const store = this.readStore();
      this.writeStore({ ...store, activePersonaId: null });
    });
  }

  public markReviewed(idOrName: string): AgentPersonaRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown persona ${idOrName}`);
      const updated: AgentPersonaRecord = {
        ...existing,
        ...reviewedReviewPatch(),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        personas: store.personas.map((persona) => persona.id === existing.id ? updated : persona),
      });
      return updated;
    });
  }

  public markStale(idOrName: string, reason: string): AgentPersonaRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown persona ${idOrName}`);
      const updated: AgentPersonaRecord = {
        ...existing,
        ...staleReviewPatch(reason),
        updatedAt: nowIso(),
      };
      this.writeStore({
        ...store,
        personas: store.personas.map((persona) => persona.id === existing.id ? updated : persona),
      });
      return updated;
    });
  }

  public deletePersona(idOrName: string): AgentPersonaRecord {
    return this.locked(() => {
      const store = this.readStore();
      const existing = this.findInStore(store, idOrName);
      if (!existing) throw new Error(`Unknown persona ${idOrName}`);
      this.writeStore({
        ...store,
        activePersonaId: store.activePersonaId === existing.id ? null : store.activePersonaId,
        personas: store.personas.filter((persona) => persona.id !== existing.id),
      });
      return existing;
    });
  }

  private validateRequired(name: string, description: string, body: string): void {
    if (!name) throw new Error('Persona name is required.');
    if (!description) throw new Error('Persona description is required.');
    if (!body) throw new Error('Persona body is required.');
  }

  private nextId(name: string, personas: readonly AgentPersonaRecord[]): string {
    const base = slugify(name);
    const ids = new Set(personas.map((persona) => persona.id));
    if (!ids.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate persona id for ${name}.`);
  }

  private findInStore(store: PersonaStoreFile, idOrName: string): AgentPersonaRecord | null {
    const lookup = idOrName.trim().toLowerCase();
    if (!lookup) return null;
    return store.personas.find((persona) => persona.id.toLowerCase() === lookup || persona.name.toLowerCase() === lookup) ?? null;
  }

  /** What the last write reported: personas this version cannot read that were kept, or a copy of an unreadable file. */
  public lastWriteReport(): JsonStoreWriteReport | undefined {
    return this.lastWrite;
  }

  private readStore(): PersonaStoreFile {
    return toPersonaStore(this.held ?? readJsonStore(this.storePath, PERSONA_STORE));
  }

  /** One locked read-modify-write; the file is read once and entries this version cannot read are written back as found. */
  private locked<T>(update: () => T): T {
    return runLockedStoreUpdate(this.storePath, this.effects, () => {
      this.held = readJsonStore(this.storePath, PERSONA_STORE);
      try {
        return update();
      } finally {
        this.held = null;
      }
    });
  }

  private writeStore(store: PersonaStoreFile): void {
    const read = this.held ?? readJsonStore(this.storePath, PERSONA_STORE);
    this.lastWrite = writeJsonStore(read, PERSONA_STORE, {
      entries: store.personas,
      fields: { ...read.fields, activePersonaId: store.activePersonaId },
    }, this.effects);
  }
}

export function buildActivePersonaPrompt(shellPaths: ShellPathService, snapshot?: AgentPersonaSnapshot): string | null {
  const active = (snapshot ?? AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot()).activePersona;
  if (!active) return null;
  if (active.reviewState !== 'reviewed') {
    return [
      '## Active GoodVibes Agent Persona',
      `Name: ${active.name}`,
      `Review: ${formatAgentRecordReviewState(active.reviewState)}`,
      'This persona is active but not applied because it is not reviewed. Use the learning curator or persona review route before allowing it to steer assistant behavior.',
    ].join('\n');
  }
  return [
    '## Active GoodVibes Agent Persona',
    `Name: ${active.name}`,
    `Description: ${active.description}`,
    `Review: ${formatAgentRecordReviewState(active.reviewState)}`,
    '',
    active.body,
    '',
    'Apply this persona inside the same serial assistant conversation. Do not spawn separate Agent jobs because a persona is active.',
  ].join('\n');
}

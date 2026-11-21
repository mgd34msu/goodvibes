import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  collectMarkdownReferences,
  extractMarkdownPreview,
  extractMarkdownSections,
  materializeMarkdownBody,
} from '../utils/markdown-disclosure.js';
import { BUILTIN_AGENT_TEMPLATES } from './builtin-templates.js';

// ---------------------------------------------------------------------------
// AgentArchetype type
// ---------------------------------------------------------------------------

/** A named agent archetype loaded from a .goodvibes/agents/*.md file
 *  or from built-in templates. */
export interface AgentArchetype {
  /** Archetype identifier (filename without extension, or template key). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Tool names the agent has access to. */
  tools: string[];
  /** Model override (optional). */
  model?: string | undefined;
  /** Provider override (optional). */
  provider?: string | undefined;
  /** System prompt injected at agent start (optional). */
  systemPrompt?: string | undefined;
  /** The `family:` front matter field of a custom file (implement, review, test, research, general). */
  family?: string | undefined;
  /** True if loaded from a markdown file, false if built-in. */
  isCustom: boolean;
  /** Where this archetype came from. */
  origin: 'builtin' | 'local-markdown';
  /** Source path when loaded from a markdown file. */
  sourcePath?: string | undefined;
  /** Validation or schema issues discovered while loading. */
  validationIssues?: readonly string[] | undefined;
  /**
   * False when the file could not be read as an archetype (no frontmatter,
   * frontmatter that is not YAML, a field of the wrong type). Such an entry is
   * listed with its issues so the owner can see it, and is never spawned.
   */
  usable?: boolean | undefined;
  /** Brief preview of the archetype body. */
  preview?: string | undefined;
  /** Lazy @ references discovered in the body. */
  includes?: readonly string[] | undefined;
  /** Markdown headings discovered in the body. */
  sections?: readonly string[] | undefined;
}

/** What a person reads for each built-in archetype: "Helper agent", never the id "general". */
const ARCHETYPE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  general: 'Helper agent',
  orchestrator: 'Coordinating agent',
  planner: 'Planning agent',
  engineer: 'Engineering agent',
  reviewer: 'Review agent',
  tester: 'Testing agent',
  researcher: 'Research agent',
  integrator: 'Integration agent',
};

/** The display name of an archetype: the built-in's name, or a custom archetype's own name. */
export function archetypeDisplayName(name: string): string {
  return Object.hasOwn(ARCHETYPE_DISPLAY_NAMES, name) ? ARCHETYPE_DISPLAY_NAMES[name]! : name;
}

const BUILT_IN_ARCHETYPES: readonly AgentArchetype[] =BUILTIN_AGENT_TEMPLATES.map((template) => ({
  name: template.name,
  description: template.description,
  tools: [...template.tools],
  isCustom: false,
  origin: 'builtin' as const,
}));

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Extract `--- frontmatter ---` + body from markdown text.
 *  Returns null if no frontmatter block is present. */
function extractFrontmatter(content: string): { raw: string; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const secondDash = trimmed.indexOf('\n---', 3);
  if (secondDash === -1) return null;

  const raw = trimmed.slice(3, secondDash).trim();
  const body = trimmed.slice(secondDash + 4).trimStart();
  return { raw, body };
}

interface Frontmatter {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly tools?: string[] | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly systemPrompt?: string | undefined;
  readonly family?: string | undefined;
}

/**
 * Read the frontmatter with a real YAML parser (block scalars, quoting and
 * empty values mean what YAML says). Returns the fields, or the reasons the
 * file cannot be used. An empty value (`description:`) reads as absent.
 */
function readFrontmatter(raw: string): { ok: true; fields: Frontmatter } | { ok: false; issues: string[] } {
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : Bun.YAML.parse(raw);
  } catch (error) {
    return { ok: false, issues: [`frontmatter is not valid YAML: ${summarizeError(error)}`] };
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, issues: ['frontmatter is not a set of key: value fields'] };
  const record = parsed as Record<string, unknown>;
  const issues: string[] = [];
  const text = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    issues.push(`'${key}' must be text`);
    return undefined;
  };
  let tools: string[] | undefined;
  const rawTools = record['tools'];
  if (Array.isArray(rawTools)) {
    if (rawTools.every((tool) => typeof tool === 'string')) tools = rawTools.map((tool) => tool.trim());
    else issues.push("'tools' must be a list of tool names");
  } else if (typeof rawTools === 'string') {
    // `tools: read` or `tools: read, write` is a list written as a scalar.
    tools = rawTools.split(',').map((tool) => tool.trim()).filter(Boolean);
  } else if (rawTools !== undefined && rawTools !== null) {
    issues.push("'tools' must be a list of tool names");
  }
  const fields: Frontmatter = {
    name: text('name'),
    description: text('description'),
    tools,
    model: text('model'),
    provider: text('provider'),
    systemPrompt: text('system_prompt'),
    family: text('family'),
  };
  return issues.length > 0 ? { ok: false, issues } : { ok: true, fields };
}

function validateArchetype(archetype: Omit<AgentArchetype, 'validationIssues'>): string[] {
  const issues: string[] = [];
  if (!archetype.name.trim()) issues.push('missing name');
  if (!archetype.description.trim()) issues.push('missing description');
  if (archetype.tools.length === 0) issues.push('no tools declared');
  const uniqueTools = new Set(archetype.tools.map((tool) => tool.trim()).filter(Boolean));
  if (uniqueTools.size !== archetype.tools.length) issues.push('duplicate or empty tool declarations');
  if (archetype.systemPrompt !== undefined && !archetype.systemPrompt.trim()) issues.push('system_prompt is empty');
  return issues;
}

// ---------------------------------------------------------------------------
// ArchetypeLoader
// ---------------------------------------------------------------------------

function statSignature(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    return `missing:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

/** Loads and caches agent archetypes from .goodvibes/agents/*.md files.
 *
 * Progressive loading:
 *  - `listArchetypes()` returns all known archetypes (frontmatter only);
 *    full body (system_prompt) is populated on first call to `loadArchetype()`.
 *  - Built-in archetypes are available when no local .md file is found.
 *
 * Freshness: every list or load stats the directory, the files of the last
 * scan and the files their prompts included (one `stat` each) and scans again
 * when any of them changed, so a file added or edited in a running app,
 * included files too, is what the next spawn and listing use.
 */
export class ArchetypeLoader {
  /** Map from archetype name -> AgentArchetype (may be partially loaded) */
  private cache = new Map<string, AgentArchetype>();
  /** Map from archetype name -> raw markdown body (lazy) */
  private bodyCache = new Map<string, string>();
  /**
   * The prompt as run, `@` references read, by archetype name: a form of its
   * own beside the body as written, so a listing after a run still shows the
   * text as written. Cleared with the scan that would change it.
   */
  private resolvedCache = new Map<string, string>();
  /** The stat signature of the last scan and of the files its prompts included; null before the first. */
  private signature: Map<string, string> | null = null;
  /** Directory to scan for .md files */
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? '';
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  private isCurrent(): boolean {
    const signature = this.signature;
    if (!signature) return false;
    if (!this.dir) return true;
    for (const [path, stamp] of signature) {
      if (statSignature(path) !== stamp) return false;
    }
    return true;
  }

  /** Scan the agents directory when it changed since the last scan. */
  private scan(): void {
    if (this.isCurrent()) return;
    this.cache.clear();
    this.bodyCache.clear();
    this.resolvedCache.clear();

    // Seed built-ins first; local markdown files override matching names.
    for (const builtin of BUILT_IN_ARCHETYPES) {
      this.cache.set(builtin.name, { ...builtin, tools: [...builtin.tools] });
    }

    const signature = new Map<string, string>();
    this.signature = signature;
    if (!this.dir) {
      logger.debug('ArchetypeLoader: no archetype directory configured, using built-ins only');
      return;
    }

    // The directory stamp is taken before reading it, so a change during the scan is seen next time.
    signature.set(this.dir, statSignature(this.dir));
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.md')).sort();
    } catch {
      // Directory doesn't exist, built-ins are the only archetypes
      logger.debug('ArchetypeLoader: agents dir not found, using built-ins', { dir: this.dir });
      return;
    }

    const declaredBy = new Map<string, string>();
    for (const file of files) {
      const filePath = join(this.dir, file);
      signature.set(filePath, statSignature(filePath));
      const fallbackName = file.replace(/\.md$/, '');
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch (err) {
        this.addUnusable(fallbackName, filePath, [`could not be read: ${summarizeError(err)}`], declaredBy);
        continue;
      }
      const parsed = extractFrontmatter(content);
      if (!parsed) {
        this.addUnusable(fallbackName, filePath, ['has no --- frontmatter block'], declaredBy);
        continue;
      }
      const frontmatter = readFrontmatter(parsed.raw);
      if (!frontmatter.ok) {
        this.addUnusable(fallbackName, filePath, frontmatter.issues, declaredBy);
        continue;
      }
      const fm = frontmatter.fields;
      const name = fm.name?.trim() || fallbackName;

      const archetype: AgentArchetype = {
        name,
        description: fm.description ?? '',
        tools: fm.tools ?? [],
        model: fm.model?.trim() || undefined,
        provider: fm.provider?.trim() || undefined,
        family: fm.family?.trim() || undefined,
        // systemPrompt intentionally omitted here, lazy loaded
        isCustom: true,
        origin: 'local-markdown',
        sourcePath: filePath,
        usable: true,
      };

      if (fm.systemPrompt !== undefined) {
        // An inline system_prompt replaces the markdown body.
        archetype.systemPrompt = fm.systemPrompt;
      } else {
        archetype.preview = extractMarkdownPreview(parsed.body);
        archetype.includes = collectMarkdownReferences(parsed.body);
        archetype.sections = extractMarkdownSections(parsed.body);
      }

      const issues = validateArchetype(archetype);
      const builtin = BUILT_IN_ARCHETYPES.find((candidate) => candidate.name === name);
      if (builtin) {
        issues.push(`replaces the built-in '${name}' archetype`);
        const added = archetype.tools.filter((tool) => !builtin.tools.includes(tool));
        if (added.length > 0) issues.push(`adds tools the built-in '${name}' archetype does not have: ${added.join(', ')}`);
      }
      archetype.validationIssues = issues;
      if (this.register(archetype, file, declaredBy) && fm.systemPrompt === undefined) this.bodyCache.set(name, parsed.body);
    }
  }

  /** Keep the first file that declares a name; a later one is reported on the kept entry, never silently dropped. */
  private register(archetype: AgentArchetype, file: string, declaredBy: Map<string, string>): boolean {
    const first = declaredBy.get(archetype.name);
    if (first !== undefined) {
      const kept = this.cache.get(archetype.name);
      const issue = `the name '${archetype.name}' is declared by both ${first} and ${file}; ${file} is ignored until one of them is renamed`;
      if (kept) kept.validationIssues = [...(kept.validationIssues ?? []), issue];
      logger.warn('ArchetypeLoader: two agent files declare one name', { name: archetype.name, kept: first, ignored: file });
      return false;
    }
    declaredBy.set(archetype.name, file);
    if ((archetype.validationIssues?.length ?? 0) > 0) {
      logger.warn('ArchetypeLoader: agent file has issues', { file, issues: archetype.validationIssues });
    }
    this.cache.set(archetype.name, archetype);
    return true;
  }

  private addUnusable(name: string, sourcePath: string, issues: string[], declaredBy: Map<string, string>): void {
    const file = sourcePath.slice(this.dir.length + 1);
    this.register({
      name,
      description: '',
      tools: [],
      isCustom: true,
      origin: 'local-markdown',
      sourcePath,
      usable: false,
      validationIssues: [...issues, 'not used: fix the file and it is read again on the next listing or spawn'],
    }, file, declaredBy);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Load a named archetype with full content (including system prompt).
   *  Returns null if not found in files or built-ins, or if its file cannot be used. */
  loadArchetype(name: string): AgentArchetype | null {
    this.scan();

    const archetype = this.cache.get(name);
    if (!archetype || archetype.usable === false) return null;

    // The body as run: read once per scan, kept apart from the cached entry,
    // which keeps the text as written (listArchetypes shows that).
    const owned = copyArchetype(archetype);
    if (!archetype.systemPrompt && this.bodyCache.has(name)) {
      let resolved = this.resolvedCache.get(name);
      if (resolved === undefined) {
        const body = this.bodyCache.get(name)!;
        const included = new Set<string>();
        resolved = archetype.sourcePath ? materializeMarkdownBody(archetype.sourcePath, body, included) : body;
        this.resolvedCache.set(name, resolved);
        // Each file the prompt includes joins the scan's signature, so an edit to
        // one of them (an `@shared/rules.md` include) makes the next load read it again.
        for (const path of included) {
          if (!this.signature?.has(path)) this.signature?.set(path, statSignature(path));
        }
      }
      owned.systemPrompt = resolved;
    }
    return owned;
  }

  /**
   * List all known archetypes, unusable files included with their issues.
   * Frontmatter only by default; `withPrompts` adds each file's prompt text as
   * written (its `@` references are not read).
   */
  listArchetypes(options: { readonly withPrompts?: boolean } = {}): AgentArchetype[] {
    this.scan();
    return Array.from(this.cache.values()).map((a) => {
      const body = options.withPrompts && a.systemPrompt === undefined ? this.bodyCache.get(a.name) : undefined;
      const owned = copyArchetype(a);
      if (body !== undefined) owned.systemPrompt = body;
      return owned;
    });
  }

  /** Merge archetype config with runtime overrides.
   *  Override properties take precedence over archetype defaults.
   *  Returns null if the named archetype is not found. */
  mergeWithOverrides(
    name: string,
    overrides: {
      model?: string | undefined;
      provider?: string | undefined;
      tools?: string[] | undefined;
    },
  ): AgentArchetype | null {
    const archetype = this.loadArchetype(name);
    if (!archetype) return null;

    return {
      ...archetype,
      model: overrides.model ?? archetype.model,
      provider: overrides.provider ?? archetype.provider,
      tools: overrides.tools ?? archetype.tools,
    };
  }

  /** Forget the last scan so the next access reads the directory again. */
  clear(): void {
    this.cache.clear();
    this.bodyCache.clear();
    this.resolvedCache.clear();
    this.signature = null;
  }
}

/** An archetype the caller owns: its arrays are its own, so changing them never reaches the loader's cache. */
function copyArchetype(archetype: AgentArchetype): AgentArchetype {
  return {
    ...archetype,
    tools: [...archetype.tools],
    ...(archetype.validationIssues ? { validationIssues: [...archetype.validationIssues] } : {}),
    ...(archetype.includes ? { includes: [...archetype.includes] } : {}),
    ...(archetype.sections ? { sections: [...archetype.sections] } : {}),
  };
}

const sharedLoaders = new Map<string, ArchetypeLoader>();

/**
 * The process's one loader for an agents directory. The runtime services and
 * `/teamwork` both read through it, so a listing and a spawn always agree.
 */
export function archetypeLoaderFor(directory: string): ArchetypeLoader {
  const key = resolve(directory);
  let loader = sharedLoaders.get(key);
  if (!loader) {
    loader = new ArchetypeLoader(key);
    sharedLoaders.set(key, loader);
  }
  return loader;
}

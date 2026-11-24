import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { logger } from '../../utils/logger.js';
import { captureJudgmentPort } from '@goodvibes/engine/errors';
import { retainStrictJudgmentJson, prepareJudgmentResult } from '../../gate/judgment-result.js';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { registryCandidateView, registryRank } from '../batteries/registry-rank.js';
import {
  collectMarkdownReferences,
  extractMarkdownPreview,
  normalizeFrontmatterList,
  parseMarkdownFrontmatter,
} from '../../utils/markdown-disclosure.js';
import type { Tool, ToolDefinition, ToolExecuteOptions } from '../../types/tools.js';
import type { ToolRegistry } from '../registry.js';
import { REGISTRY_TOOL_SCHEMA } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';
import type { RegistryInput } from './schema.js';
import { summarizeError } from '../../utils/error-display.js';
import type { ContractInputAuthority } from '../../contract/input-authority.js';
import {
  createLiveRegistrySource, liveRegistryScope, registryAgentDirectories, registryMarkdown, registrySkillRoots,
  materializeRegistryMarkdown, type RegistryToolSource,
} from './source.js';
import { findSkill, listSkillIndex, listSkills } from '../../skills/discovery.js';
import type { SkillFrontmatterValue } from '../../skills/model.js';
import { capturedRegistryAdmission, type CapturedRegistryContext } from './captured-source.js';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { rankClassicCatalog, type ClassicCatalogMatch } from '../../runtime/classic-catalog.js';

const capturedTools = new WeakMap<Tool, ContractInputAuthority>();
export function isCapturedRegistryTool(tool: Tool, authority: ContractInputAuthority): boolean {
  return capturedTools.get(tool) === authority;
}

// ---------------------------------------------------------------------------
// Directory scanning helpers
// ---------------------------------------------------------------------------

interface RegistryMatch {
  name: string;
  type: 'skill' | 'agent' | 'tool';
  description: string;
  path: string;
  preview?: string | undefined;
  dependencies?: string[] | undefined;
  includes?: string[] | undefined;
  sections?: string[] | undefined;
}

/** Complete source is for judgments; output previews remain concise. */

export interface RegistryToolRoots {
  readonly workingDirectory: string;
  readonly homeDirectory?: string | undefined;
  /** The product surface whose own skill folder is searched too (platform/skills resolveSkillRoots). */
  readonly surfaceRoot?: string | undefined;
  readonly capturedInput?: CapturedRegistryContext | undefined;
}

/** A frontmatter list (`a, b` or `[a, b]`) as its entries. */
function frontmatterList(value: SkillFrontmatterValue | undefined): string[] {
  return normalizeFrontmatterList(typeof value === 'string' || value === undefined ? value : [...value]);
}

/**
 * The skills a session loads, read through `source` by platform/skills: the
 * same names, case rules, descriptions and project-over-global override.
 */
async function listRegistrySkills(roots: RegistryToolRoots, source: RegistryToolSource): Promise<RegistryMatch[]> {
  return (await listSkills(registrySkillRoots(roots), source)).map((skill): RegistryMatch => ({
    name: skill.name,
    type: 'skill',
    description: skill.description,
    path: skill.path,
    preview: extractMarkdownPreview(skill.body),
    dependencies: frontmatterList(skill.metadata['depends_on']),
    includes: collectMarkdownReferences(skill.body),
  }));
}

/** An agent directory or file a live search could not list or read, and why. */
interface RegistrySkip {
  readonly path: string;
  readonly reason: string;
}

/** Whether a read failed only because the entry is no longer there. */
function isMissingEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The agents in one `.goodvibes/agents` directory: flat `<name>.md` files and `<folder>/AGENT.md`.
 * Only a missing entry counts as absent. A captured source's refusal is rethrown so the whole
 * output is withheld, never returned partial; a live entry that cannot be listed or read is
 * named in `skipped` with its reason.
 */
async function scanAgentDirectory(dir: string, source: RegistryToolSource, skipped: RegistrySkip[]): Promise<RegistryMatch[]> {
  if (!await source.exists(dir)) return [];
  const results: RegistryMatch[] = [];
  let entries: readonly string[];
  try {
    entries = await source.list(dir);
  } catch (error) {
    if (!source.live) throw error;
    if (!isMissingEntry(error)) skipped.push({ path: dir, reason: summarizeError(error) });
    return [];
  }
  for (const entry of entries) {
    const flat = entry.endsWith('.md');
    const filePath = flat ? join(dir, entry) : join(dir, entry, 'AGENT.md');
    if (!flat && !await source.exists(filePath)) continue;
    let content = '';
    try {
      content = await source.read(filePath);
    } catch (error) {
      if (!source.live) throw error;
      if (!isMissingEntry(error)) skipped.push({ path: filePath, reason: summarizeError(error) });
      continue;
    }
    const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
    const fallbackName = flat ? entry.replace(/\.md$/, '') : entry;
    results.push({
      name: typeof frontmatter['name'] === 'string' ? frontmatter['name'] : fallbackName,
      type: 'agent',
      description: typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '',
      path: filePath,
      preview: extractMarkdownPreview(body),
      dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
      includes: collectMarkdownReferences(body),
    });
  }
  return results;
}

async function listRegistryAgents(roots: RegistryToolRoots, source: RegistryToolSource, skipped: RegistrySkip[]): Promise<RegistryMatch[]> {
  const agents: RegistryMatch[] = [];
  for (const dir of registryAgentDirectories(roots)) agents.push(...await scanAgentDirectory(dir, source, skipped));
  return dedupeAgents(agents);
}

/** The decision site the registry-rank reading is logged under. */
export const REGISTRY_RANK_SITE = 'tools.registry-rank';

/** A project agent overrides a global one of the same name (first seen wins). */
function dedupeAgents(items: readonly RegistryMatch[]): RegistryMatch[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Most candidates the one model request is shown; code ranks and cuts to these. */
const REGISTRY_SHORTLIST = 8;

interface RegistryRanking { matching: RegistryMatch[]; rest: RegistryMatch[]; note?: string }

const registryId = (item: RegistryMatch): string => `${item.type}:${item.name}`;
const byName = (a: RegistryMatch, b: RegistryMatch): number => a.name.localeCompare(b.name);

/** The code ranking: literal-overlap matches best first, the rest alphabetically. */
function classicRanking(items: readonly RegistryMatch[], query: string): { matches: readonly ClassicCatalogMatch<RegistryMatch>[]; ranking: RegistryRanking } {
  const matches = rankClassicCatalog(items, query, item => ({ id: registryId(item), description: item.description }));
  const selected = new Set(matches.map(match => match.entry));
  return { matches, ranking: { matching: matches.map(match => match.entry), rest: items.filter(item => !selected.has(item)).sort(byName) } };
}

/**
 * Orders the candidates against `query` (search words or a task description).
 * Code decides first: an exact name or id is the answer, and a single
 * candidate that carries every query word is a clear winner; neither costs a
 * request. Otherwise one `engine.tools.registry-rank` request reads the top
 * few code-ranked candidates together. `matching` holds the candidates read as
 * fitting, then the other literal matches in code order; `rest` holds the
 * others alphabetically. A failed or unsure reading leaves the code order in
 * place and says so in `note`.
 */
async function rankAgainst(
  items: readonly RegistryMatch[],
  query: string,
  source: RegistryToolSource,
): Promise<RegistryRanking> {
  source.signal?.throwIfAborted();
  const wanted = query.trim().toLocaleLowerCase();
  const exact = items.filter(item => item.name.toLocaleLowerCase() === wanted || registryId(item).toLocaleLowerCase() === wanted);
  if (exact.length > 0) {
    const chosen = new Set(exact);
    return { matching: exact, rest: items.filter(item => !chosen.has(item)).sort(byName) };
  }
  const { matches, ranking } = classicRanking(items, query);
  const [first, second] = matches;
  const clearWinner = first !== undefined && first.score === 1 && (second === undefined || second.score < 1);
  if (clearWinner || items.length === 0) return ranking;
  return decisionOrClassic(() => rankDecisionAgainst(items, query, source, matches, ranking), () => ranking);
}

async function rankDecisionAgainst(
  items: readonly RegistryMatch[],
  query: string,
  source: RegistryToolSource,
  matches: readonly ClassicCatalogMatch<RegistryMatch>[],
  ranking: RegistryRanking,
): Promise<RegistryRanking> {
  // The shortlist is the code's best literal matches; with none, the first entries alphabetically.
  const shortlist = (matches.length > 0 ? matches.map(match => match.entry) : [...items].sort(byName)).slice(0, REGISTRY_SHORTLIST);
  const byId = new Map(shortlist.map((item) => [registryId(item), item]));
  const candidates = shortlist.map(item => ({ id: registryId(item), content: registryCandidateView(item) }));
  const original = retainStrictJudgmentJson({ query, candidates });
  assertJudgmentInput(original.snapshot);
  const owner = captureJudgmentPort(REGISTRY_RANK_SITE, { signal: source.signal, assertCurrent: original.assertCurrent, prepareResultCapture: prepareJudgmentResult });
  let ranked: Awaited<ReturnType<typeof registryRank.rerank>>['ranked'];
  try {
    ({ ranked } = await registryRank.rerank(owner.port, original.snapshot.query, original.snapshot.candidates, { site: REGISTRY_RANK_SITE, signal: owner.signal }));
  } catch (error) {
    if (source.signal?.aborted) throw error;
    logger.debug('registry: ranking reading failed; returning the literal-match order', { error: summarizeError(error) });
    return { ...ranking, note: 'Ordered by literal word match: the ranking reading did not complete.' };
  }
  source.signal?.throwIfAborted(); owner.assertCurrent();
  const fitting = ranked.filter(entry => entry.reading.outcome === 'act' && entry.reading.verdict === 'yes').map(entry => byId.get(entry.id)!);
  const refused = new Set(ranked.filter(entry => entry.reading.outcome === 'act' && entry.reading.verdict === 'no').map(entry => byId.get(entry.id)!));
  const placed = new Set(fitting);
  const matching = [...fitting, ...ranking.matching.filter(item => !placed.has(item) && !refused.has(item))];
  const kept = new Set(matching);
  const unsure = ranked.some(entry => entry.reading.outcome !== 'act');
  return {
    matching,
    rest: items.filter(item => !kept.has(item)).sort(byName),
    ...(unsure ? { note: 'Some candidates could not be read with confidence; they are listed by literal word match.' } : {}),
  };
}

function listTools(toolRegistry: ToolRegistry): RegistryMatch[] {
  return toolRegistry.list().map((t): RegistryMatch => ({ name: t.definition.name, type: 'tool', description: t.definition.description, path: '' }));
}


// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the `registry` tool bound to the given ToolRegistry.
 *
 * Returns a Tool object conforming to the Tool interface.
 * Never throws from execute().
 */
export function createRegistryTool(toolRegistry: ToolRegistry, roots: RegistryToolRoots): Tool {
  const captured = roots.capturedInput === undefined ? undefined : capturedRegistryAdmission(roots.capturedInput);
  roots = Object.freeze(captured
    ? { workingDirectory: captured.workingDirectory, homeDirectory: captured.homeDirectory, surfaceRoot: captured.surfaceRoot }
    : { workingDirectory: roots.workingDirectory, homeDirectory: roots.homeDirectory, surfaceRoot: roots.surfaceRoot });
  const liveSource = createLiveRegistrySource(roots);
  const definition: ToolDefinition = {
    name: 'registry',
    description:
      'Discover and inspect skills, agents, and tools.'
      + ' Modes: search finds items by keyword; recommend lists items sorted by relevance;'
      + ' dependencies reads a skill\'s dependency chain; preview returns metadata and preview text without the linked content;'
      + ' content returns full markdown file.',
    parameters: toRecord(REGISTRY_TOOL_SCHEMA),
    sideEffects: ['read_fs'],
    subjects: { paths: ['path'] },
    concurrency: 'parallel',
  };

  async function execute(
    args: Record<string, unknown>,
    options?: ToolExecuteOptions,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return withConfiguredDecisionModelPolicy(() => executeUnderPolicy(args, options));
  }
  async function executeUnderPolicy(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string }> {
    const signal = options?.signal;
    const source = captured?.source(signal) ?? liveSource;
    try {
      args = structuredClone(args);
      signal?.throwIfAborted();
      await source.assertCurrent();
      if (!args.mode || typeof args.mode !== 'string') {
        return { success: false, error: 'Missing required "mode" field' };
      }
      const input = args as unknown as RegistryInput;
      const { mode } = input;

      const result = await (async () => {
        switch (mode) {
          case 'search':       return runSearch(input, toolRegistry, roots, source);
          case 'recommend':    return runRecommend(input, toolRegistry, roots, source);
          case 'dependencies': return runDependencies(input, roots, source);
          case 'preview':      return runPreview(input, roots, source);
          case 'content':      return runContent(input, roots, source);
          default: return { success: false, error: `Unknown mode: ${String(mode)}` };
        }
      })();
      await source.assertCurrent();
      signal?.throwIfAborted();
      return result;
    } catch (err) {
      if (captured) return { success: false, error: 'Captured registry input held: missing, changed, cancelled or restricted original-owner authority. Output withheld.' };
      if (err instanceof JudgmentInputError) return { success: false, error: err.message };
      const message = summarizeError(err);
      logger.error('registry tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  }

  const tool = { definition, execute };
  if (captured) capturedTools.set(tool, captured.authority);
  return tool;
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

async function runSearch(
  input: RegistryInput,
  toolRegistry: ToolRegistry,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const query = input.query ?? '';
  const typeFilter = input.type ?? 'all';
  const all: RegistryMatch[] = [];
  const skipped: RegistrySkip[] = [];

  if (typeFilter === 'skills' || typeFilter === 'all') {
    all.push(...await listRegistrySkills(roots, source));
  }
  if (typeFilter === 'agents' || typeFilter === 'all') {
    all.push(...await listRegistryAgents(roots, source, skipped));
  }
  if (typeFilter === 'tools' || typeFilter === 'all') {
    all.push(...listTools(toolRegistry));
  }

  const candidates = all;
  const ranking = query ? await rankAgainst(candidates, query, source) : undefined;
  const results = ranking ? ranking.matching : candidates;

  return {
    success: true,
    output: JSON.stringify({
      mode: 'search',
      ...(isClassicOperation() ? { provenance: 'classic', match_source: 'literal-token-overlap' } : {}),
      query,
      count: results.length,
      ...(ranking?.note ? { note: ranking.note } : {}),
      results,
      // Agent files that exist but could not be read, so a missing agent is not taken for an absent one.
      ...(skipped.length > 0 ? { skipped } : {}),
    }),
  };
}

async function runRecommend(
  input: RegistryInput,
  toolRegistry: ToolRegistry,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const task = input.task ?? '';
  const scope = input.scope ?? 'skills';

  let candidates: RegistryMatch[];
  if (scope === 'tools') {
    candidates = listTools(toolRegistry);
  } else {
    candidates = await listRegistrySkills(roots, source);
  }

  // With a task: the candidates read as fitting it, best first, then the rest
  // alphabetically. Without one: every candidate alphabetically.
  let sorted: RegistryMatch[];
  let note: string | undefined;
  if (task) {
    const { matching, rest, note: rankingNote } = await rankAgainst(candidates, task, source);
    sorted = [...matching, ...rest];
    note = rankingNote;
  } else {
    sorted = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    success: true,
    output: JSON.stringify({
      mode: 'recommend',
      ...(isClassicOperation() ? { provenance: 'classic', match_source: 'literal-token-overlap' } : {}),
      task,
      scope,
      count: sorted.length,
      ...(note ? { note } : {}),
      results: sorted,
    }),
  };
}

async function runDependencies(
  input: RegistryInput,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const skillName = input.skillName;
  if (!skillName) {
    return Promise.resolve({
      success: false,
      error: 'mode "dependencies" requires "skillName"',
    });
  }

  // Resolved as the session resolves a skill (platform/skills findSkill: its
  // name, case not mattering, the first root winning); else a listed skill
  // whose file or folder carries the name. The name is only compared with
  // what the listing found, never joined into a path by this tool.
  const skillRoots = registrySkillRoots(roots);
  const wanted = skillName.toLowerCase();
  const found = await findSkill(skillRoots, skillName, source)
    ?? (await listSkillIndex(skillRoots, source)).find((entry) => {
      const file = basename(entry.path);
      const stem = file === 'SKILL.md' ? basename(dirname(entry.path)) : file.replace(/\.md$/, '');
      return stem.toLowerCase() === wanted || file.toLowerCase() === wanted;
    });

  if (!found) {
    return {
      success: false,
      error: `Skill not found: ${skillName}. Use mode=search type=skills to list the available skill names${/[\\/]/.test(skillName) ? ', or mode=content to read a skill file by its path' : ''}.`,
    };
  }

  const disclosure = await registryMarkdown(source, found.path);
  return {
    success: true,
    output: JSON.stringify({
      mode: 'dependencies',
      skillName,
      path: found.path,
      depends_on: frontmatterList(found.metadata['depends_on']),
      includes: disclosure.includes,
    }),
  };
}

async function runPreview(
  input: RegistryInput,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const resolvedPath = await resolveRegistryPath(input.path, roots, source);
  if (!resolvedPath.ok) return Promise.resolve({ success: false, error: resolvedPath.error });

  try {
    const disclosure = await registryMarkdown(source, resolvedPath.path);
    return Promise.resolve({
      success: true,
      output: JSON.stringify({
        mode: 'preview',
        path: disclosure.path,
        metadata: disclosure.metadata,
        preview: disclosure.preview,
        includes: disclosure.includes,
        sections: disclosure.sections,
        dependencies: normalizeFrontmatterList(disclosure.metadata['depends_on']),
      }),
    });
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: `Failed to preview file: ${summarizeError(err)}`,
    });
  }
}

async function runContent(
  input: RegistryInput,
  roots: RegistryToolRoots,
  source: RegistryToolSource,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const resolvedPath = await resolveRegistryPath(input.path, roots, source);
  if (!resolvedPath.ok) return Promise.resolve({ success: false, error: resolvedPath.error });

  try {
    const disclosure = await registryMarkdown(source, resolvedPath.path);
    return {
      success: true,
      output: JSON.stringify({
        mode: 'content',
        path: resolvedPath.path,
        metadata: disclosure.metadata,
        content: await materializeRegistryMarkdown(source, resolvedPath.path, disclosure.body),
      }),
    };
  } catch (err) {
    // Captured sources hold content through the outer handler; a live refusal names its reason.
    if (!source.live) throw err;
    return { success: false, error: `Failed to read file: ${summarizeError(err)}` };
  }
}

async function resolveRegistryPath(path: string | undefined, roots: RegistryToolRoots, source: RegistryToolSource): Promise<
  | { ok: true; path: string }
  | { ok: false; error: string }> {
  if (!path) {
    return {
      ok: false,
      error: 'mode requires "path"',
    };
  }

  // Normalise first so `..` segments cannot hide an escape; live reads also
  // resolve symlinks (in the live source) before touching the file.
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(roots.workingDirectory, path);
  const insideScope = liveRegistryScope(roots).some((root) => {
    const rel = relative(root, resolvedPath);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  });

  if (!insideScope) {
    return {
      ok: false,
      error: `mode can only read files inside the skill folders (.goodvibes/skills and .goodvibes/<surface>/skills) or .goodvibes/agents (of the project or the home directory); ${resolvedPath} is outside them. Use mode=search to list the available files.`,
    };
  }

  if (!await source.exists(resolvedPath)) {
    return {
      ok: false,
      error: `File not found: ${resolvedPath}`,
    };
  }

  return { ok: true, path: resolvedPath };
}

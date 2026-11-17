import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { logger } from '../../utils/logger.js';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
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
import { createLiveRegistrySource, liveRegistryScope, registryMarkdown, materializeRegistryMarkdown, type RegistryToolSource } from './source.js';
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
  readonly capturedInput?: CapturedRegistryContext | undefined;
}

async function scanDirectoryAll(
  dir: string,
  itemType: 'skill' | 'agent',
  source: RegistryToolSource,
): Promise<RegistryMatch[]> {
  if (!await source.exists(dir)) return [];
  const results: RegistryMatch[] = [];
  let entries: readonly string[];
  try {
    entries = await source.list(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    // Strategy 1: flat .md file (e.g., skills/foo.md)
    if (entry.endsWith('.md')) {
      const filePath = join(dir, entry);
      let content = '';
      try {
        content = await source.read(filePath);
      } catch {
        continue;
      }
      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : entry.replace(/\.md$/, '');
      const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
      const match: RegistryMatch = {
        name,
        type: itemType,
        description,
        path: filePath,
        preview: extractMarkdownPreview(body),
        dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
        includes: collectMarkdownReferences(body),
      };
      results.push(match);
      continue;
    }

    // Strategy 2: directory with SKILL.md or AGENT.md (e.g., skills/foo/SKILL.md)
    const markerFile = itemType === 'skill' ? 'SKILL.md' : 'AGENT.md';
    const markerPath = join(dir, entry, markerFile);
    if (await source.exists(markerPath)) {
      let content = '';
      try {
        content = await source.read(markerPath);
      } catch {
        continue;
      }
      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : entry;
      const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
      const match: RegistryMatch = {
        name,
        type: itemType,
        description,
        path: markerPath,
        preview: extractMarkdownPreview(body),
        dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
        includes: collectMarkdownReferences(body),
      };
      results.push(match);
    }
  }
  return results;
}

/** The decision site the registry-rank reading is logged under. */
export const REGISTRY_RANK_SITE = 'tools.registry-rank';

/** Project-local entries override global ones of the same type and name (first seen wins). */
function dedupe(items: readonly RegistryMatch[]): RegistryMatch[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.name}`;
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

function getSkillDirs(roots: RegistryToolRoots): string[] {
  const dirs = [
    join(roots.workingDirectory, '.goodvibes', 'skills'),
  ];
  if (roots.homeDirectory) {
    dirs.push(
      join(roots.homeDirectory, '.goodvibes', 'skills'),
    );
  }
  return dirs;
}

function getAgentDirs(roots: RegistryToolRoots): string[] {
  const dirs = [
    join(roots.workingDirectory, '.goodvibes', 'agents'),
  ];
  if (roots.homeDirectory) {
    dirs.push(
      join(roots.homeDirectory, '.goodvibes', 'agents'),
    );
  }
  return dirs;
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
    ? { workingDirectory: captured.workingDirectory, homeDirectory: captured.homeDirectory }
    : { workingDirectory: roots.workingDirectory, homeDirectory: roots.homeDirectory });
  const liveSource = createLiveRegistrySource(roots);
  const definition: ToolDefinition = {
    name: 'registry',
    description:
      'Discover and inspect skills, agents, and tools.'
      + ' Modes: search finds items by keyword; recommend lists items sorted by relevance;'
      + ' dependencies reads a skill\'s dependency chain; content returns full markdown file.',
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

  if (typeFilter === 'skills' || typeFilter === 'all') {
    for (const dir of getSkillDirs(roots)) all.push(...await scanDirectoryAll(dir, 'skill', source));
  }
  if (typeFilter === 'agents' || typeFilter === 'all') {
    for (const dir of getAgentDirs(roots)) all.push(...await scanDirectoryAll(dir, 'agent', source));
  }
  if (typeFilter === 'tools' || typeFilter === 'all') {
    all.push(...listTools(toolRegistry));
  }

  const candidates = dedupe(all);
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
    candidates = [];
    for (const dir of getSkillDirs(roots)) {
      candidates.push(...await scanDirectoryAll(dir, 'skill', source));
    }
    candidates = dedupe(candidates);
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

  // Same scan as search, so a name that search returns (frontmatter name,
  // file name, or the directory of a SKILL.md) resolves here too. The name is
  // only compared with what the scan found, never joined into a path.
  let found: RegistryMatch | undefined;
  for (const dir of getSkillDirs(roots)) {
    found = (await scanDirectoryAll(dir, 'skill', source)).find((match) => {
      const file = basename(match.path);
      const stem = file === 'SKILL.md' ? basename(dirname(match.path)) : file.replace(/\.md$/, '');
      return match.name === skillName || stem === skillName || file === skillName;
    });
    if (found) break;
  }

  if (!found) {
    return {
      success: false,
      error: `Skill not found: ${skillName}. Use mode=search type=skills to list the available skill names${/[\\/]/.test(skillName) ? ', or mode=content to read a skill file by its path' : ''}.`,
    };
  }

  return {
    success: true,
    output: JSON.stringify({
      mode: 'dependencies',
      skillName,
      path: found.path,
      depends_on: found.dependencies ?? [],
      includes: found.includes ?? [],
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
      error: `mode can only read files inside .goodvibes/skills or .goodvibes/agents (of the project or the home directory); ${resolvedPath} is outside them. Use mode=search to list the available files.`,
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

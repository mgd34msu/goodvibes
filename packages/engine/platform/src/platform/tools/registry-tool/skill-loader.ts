/**
 * Skill loader, finds and loads skills by trigger match.
 *
 * Reads the skills platform/skills lists for the surface (every skill folder,
 * both `<name>.md` and `<folder>/SKILL.md`, a skill's name being its frontmatter
 * `name` or its file or folder name), and returns the body of the first whose
 * triggers or `/<name>` match the input.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  parseMarkdownFrontmatter,
  normalizeFrontmatterList,
} from '../../utils/markdown-disclosure.js';
import { logger } from '../../utils/logger.js';
import { listSkillIndex, readLocatedSkill } from '../../skills/discovery.js';
import { resolveSkillRoots } from '../../skills/roots.js';
import { skillMayLoad } from '../../skills/library.js';
import type { SkillFrontmatterValue } from '../../skills/model.js';
import { isInsideLiveRegistryScope, liveRegistryScope } from './source.js';

export interface SkillLoaderRoots {
  readonly workingDirectory: string;
  readonly homeDirectory?: string | undefined;
  /** The product surface whose own skill folder (`.goodvibes/<surface>/skills`) is searched too. */
  readonly surfaceRoot?: string | undefined;
}

/**
 * Inlines `@include` lines like the registry tool does: same nesting limit,
 * cycle guard and escaped `@@` marker, but an include must stay inside the
 * skill and agent directories. An include that escapes is replaced by the line
 * `[include refused: <include> is outside the skill and agent folders]`.
 */
function materializeScoped(
  scope: readonly string[], filePath: string, body: string, visited = new Set<string>(), depth = 0,
): string {
  const path = resolve(filePath);
  if (depth >= 5 || visited.has(path)) return '';
  visited.add(path);
  const result: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trim().startsWith('@@')) {
      const marker = line.indexOf('@@');
      result.push(`${line.slice(0, marker)}${line.slice(marker + 1)}`);
      continue;
    }
    const include = line.trim().match(/^@([A-Za-z0-9_./#-]+)\s*$/);
    if (!include) { result.push(line); continue; }
    const target = resolve(dirname(path), include[1]!.split('#')[0]!);
    if (!existsSync(target)) continue;
    if (!isInsideLiveRegistryScope(scope, target)) {
      logger.warn('skill include left out: outside .goodvibes/skills and .goodvibes/agents', { skill: path, include: target });
      // A visible marker, so the model knows the file was withheld and why.
      result.push(`[include refused: ${include[1]!.split('#')[0]!} is outside the skill and agent folders]`);
      continue;
    }
    let included: string;
    try { included = readFileSync(target, 'utf-8'); } catch { continue; }
    const content = materializeScoped(scope, target, parseMarkdownFrontmatter(included).body, visited, depth + 1);
    if (content) result.push(content);
  }
  return result.join('\n');
}

function triggersOf(value: SkillFrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  return normalizeFrontmatterList(typeof value === 'string' ? value : [...value]);
}

/**
 * Find a skill whose triggers include the given input string, or whose name is
 * the input after `/`. Returns the skill body (markdown content to inject as
 * prompt), or null.
 */
export async function loadSkillByTrigger(input: string, roots: SkillLoaderRoots): Promise<string | null> {
  const normalizedInput = input.toLowerCase().trim();
  const scope = liveRegistryScope(roots);
  const entries = await listSkillIndex(resolveSkillRoots(
    { workingDirectory: roots.workingDirectory, homeDirectory: roots.homeDirectory || undefined },
    roots.surfaceRoot ?? '',
  ));
  const matches = (entry: (typeof entries)[number]): boolean =>
    triggersOf(entry.metadata.triggers).some((trigger) => trigger.toLowerCase().trim() === normalizedInput)
    || `/${entry.name}`.toLowerCase() === normalizedInput;
  for (const entry of entries) {
    // A skill switched off, or not reviewed yet, in the skill store is not loaded (skills/library.ts).
    if (!matches(entry) || !skillMayLoad(entry.metadata) || !isInsideLiveRegistryScope(scope, entry.path)) continue;
    const skill = await readLocatedSkill(entry);
    if (skill) return materializeScoped(scope, entry.path, skill.body);
  }
  return null;
}

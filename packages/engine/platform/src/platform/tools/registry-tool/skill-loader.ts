/**
 * Skill loader, finds and loads skills by trigger match.
 *
 * Scans skill directories for SKILL.md files with trigger frontmatter.
 * Returns the skill body (system prompt) if a matching trigger is found.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  parseMarkdownFrontmatter,
  normalizeFrontmatterList,
} from '../../utils/markdown-disclosure.js';
import { logger } from '../../utils/logger.js';
import { isInsideLiveRegistryScope, liveRegistryScope } from './source.js';

export interface SkillLoaderRoots {
  readonly workingDirectory: string;
  readonly homeDirectory?: string | undefined;
}

function getSkillDirs(roots: SkillLoaderRoots): string[] {
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

/**
 * Inlines `@include` lines like the registry tool does: same nesting limit,
 * cycle guard and escaped `@@` marker, but an include must stay inside the
 * skill and agent directories. An include that escapes is left out.
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
      continue;
    }
    let included: string;
    try { included = readFileSync(target, 'utf-8'); } catch { continue; }
    const content = materializeScoped(scope, target, parseMarkdownFrontmatter(included).body, visited, depth + 1);
    if (content) result.push(content);
  }
  return result.join('\n');
}

/**
 * Find a skill whose triggers include the given input string.
 * Returns the skill body (markdown content to inject as prompt), or null.
 */
export function loadSkillByTrigger(input: string, roots: SkillLoaderRoots): string | null {
  const normalizedInput = input.toLowerCase().trim();
  const scope = liveRegistryScope(roots);

  for (const dir of getSkillDirs(roots)) {
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      // Check for directory-based skill: entry/SKILL.md
      const skillPath = join(dir, entry, 'SKILL.md');
      // Also check flat file: entry.md
      const flatPath = join(dir, entry);

      let content: string | null = null;
      let filePath: string | null = null;

      if (existsSync(skillPath)) {
        filePath = skillPath;
      } else if (entry.endsWith('.md') && existsSync(flatPath)) {
        filePath = flatPath;
      }

      if (!filePath || !isInsideLiveRegistryScope(scope, filePath)) continue;

      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter.name === 'string' ? frontmatter.name : undefined;
      const triggers = normalizeFrontmatterList(frontmatter.triggers);

      for (const trigger of triggers) {
        if (trigger.toLowerCase().trim() === normalizedInput) {
          return materializeScoped(scope, filePath, body);
        }
      }

      // Also match by name: /skill-name
      if (name && `/${name}`.toLowerCase() === normalizedInput) {
        return materializeScoped(scope, filePath, body);
      }
    }
  }

  return null;
}

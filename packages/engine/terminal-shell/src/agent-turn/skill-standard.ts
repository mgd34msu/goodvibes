import { parseMarkdownFrontmatter } from '@goodvibes-jev/engine/terminal-shell/markdown-frontmatter';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNoSecretLikeText } from './persona-registry.js';
import type { AgentSkillRecord } from './skill-registry-types.js';

export interface SkillStandardParsed {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface SkillStandardParseError {
  readonly error: string;
}

const parseStandardFrontmatter = (content: string): Record<string, string> =>
  Object.fromEntries(Object.entries(parseMarkdownFrontmatter(content)).filter(([key]) => key.length > 0));

/**
 * Parse a SKILL.md in the open skill standard format.
 * Frontmatter must contain `name` and `description`; extra keys are tolerated.
 * Returns a parse error if either required key is absent or secret-looking content is found.
 */
export function parseSkillStandardMarkdown(content: string): SkillStandardParsed | SkillStandardParseError {
  content = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const frontmatter = parseStandardFrontmatter(content);
  const name = (frontmatter['name'] ?? '').trim();
  const description = (frontmatter['description'] ?? '').trim();

  if (!name) return { error: 'SKILL.md is missing required frontmatter field: name' };
  if (!description) return { error: 'SKILL.md is missing required frontmatter field: description' };

  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

  try {
    assertNoSecretLikeText([name, description, body], 'Shared skill');
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Secret-looking content rejected.' };
  }

  return { name, description, body };
}

/**
 * Render a local skill record to the open skill standard format.
 * Produces `---\nname: ...\ndescription: ...\n---\n<body>\n`
 * Round-trip safe: parse(render(skill)) recovers name, description, body.
 */
export function renderSkillStandardMarkdown(skill: Pick<AgentSkillRecord, 'name' | 'description' | 'procedure'>): string {
  const nameLine = `name: ${skill.name}`;
  // Collapse any embedded newlines/runs of whitespace so the description
  // never spans more than one line and cannot break YAML frontmatter.
  const safeDescription = skill.description
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const descLine = `description: ${safeDescription}`;
  const body = skill.procedure.trimEnd();
  return `---\n${nameLine}\n${descLine}\n---\n${body}\n`;
}

/**
 * Where a skill named `name` is exported under `destDir`: `<destDir>/<slug>/SKILL.md`.
 * Throws when the name has no letters or digits to make a folder name from.
 */
export function skillStandardFilePath(name: string, destDir: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) {
    throw new Error('skill name produces an empty folder name');
  }
  return join(destDir, slug, 'SKILL.md');
}

/**
 * Write a skill record as a SKILL.md inside `<destDir>/<slug>/SKILL.md`.
 * Throws if the file already exists and `overwrite` is not true.
 * Returns the path that was written.
 */
export function writeSkillStandardFile(
  skill: Pick<AgentSkillRecord, 'name' | 'description' | 'procedure'>,
  destDir: string,
  overwrite = false,
): string {
  const filePath = skillStandardFilePath(skill.name, destDir);
  const dir = dirname(filePath);

  if (!overwrite && existsSync(filePath)) {
    throw new Error(`Skill file already exists at ${filePath}. Pass --overwrite to replace it.`);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, renderSkillStandardMarkdown(skill), 'utf-8');
  return filePath;
}

/**
 * Persona and routine Markdown files found in the project's and your own
 * folders (`.goodvibes/personas`, `.goodvibes/agent/personas`,
 * `~/.goodvibes/personas`, `~/.goodvibes/agent/personas`, and the same for
 * routines), project first: what "import a persona file" and "import a
 * routine file" offer, and what the Agent's startup summary counts.
 */
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { markdownRecordName, parseMarkdownFrontmatter, stripMarkdownFrontmatter } from '../markdown-frontmatter.js';

export type RecordOrigin = 'project-local' | 'global' | 'custom';
export type PersonaOrigin = RecordOrigin;
export type RoutineOrigin = RecordOrigin;

export interface DiscoveredPersonaRecord {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly origin: PersonaOrigin;
  readonly body: string;
  readonly frontmatter: Record<string, string>;
}

export interface DiscoveredRoutineRecord {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly origin: RoutineOrigin;
  readonly steps: string;
  readonly frontmatter: Record<string, string>;
}

/** The file a persona folder holds its text in; the startup summary reads the same list. */
export const PERSONA_DIRECTORY_MARKERS: readonly string[] = ['PERSONA.md', 'persona.md'];
/** The file a routine folder holds its steps in; the startup summary reads the same list. */
export const ROUTINE_DIRECTORY_MARKERS: readonly string[] = ['ROUTINE.md', 'routine.md'];

function directoriesOf(kind: 'personas' | 'routines', cwd: string, homeDir: string): Array<{ root: string; origin: 'project-local' | 'global' }> {
  return [
    { root: join(cwd, '.goodvibes', kind), origin: 'project-local' },
    { root: join(cwd, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, kind), origin: 'project-local' },
    { root: join(homeDir, '.goodvibes', kind), origin: 'global' },
    { root: join(homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, kind), origin: 'global' },
  ];
}

/** Where personas are discovered, project first; the startup summary reads the same roots. */
export function getPersonaDirectories(cwd: string, homeDir: string): Array<{ root: string; origin: 'project-local' | 'global' }> {
  return directoriesOf('personas', cwd, homeDir);
}

/** Where routines are discovered, project first; the startup summary reads the same roots. */
export function getRoutineDirectories(cwd: string, homeDir: string): Array<{ root: string; origin: 'project-local' | 'global' }> {
  return directoriesOf('routines', cwd, homeDir);
}

interface ReadRecord { readonly name: string; readonly description: string; readonly path: string; readonly origin: RecordOrigin; readonly text: string; readonly frontmatter: Record<string, string> }

async function readRecordFile(path: string, origin: RecordOrigin, textKey: 'system_prompt' | 'steps'): Promise<ReadRecord | null> {
  let content = '';
  try {
    content = await fsPromises.readFile(path, 'utf-8');
  } catch {
    return null;
  }
  const frontmatter = parseMarkdownFrontmatter(content);
  const text = (frontmatter[textKey] ?? stripMarkdownFrontmatter(content)).trim();
  if (!text) return null;
  const name = markdownRecordName(frontmatter, path);
  if (!name) return null;
  return { name, description: frontmatter.description ?? frontmatter.summary ?? frontmatter.title ?? '', path, origin, text, frontmatter };
}

async function scanDirectory(root: string, origin: RecordOrigin, markers: readonly string[], textKey: 'system_prompt' | 'steps'): Promise<ReadRecord[]> {
  let entries: string[] = [];
  try {
    entries = await fsPromises.readdir(root);
  } catch {
    return [];
  }
  const records: ReadRecord[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry.endsWith('.md')) {
      const record = await readRecordFile(join(root, entry), origin, textKey);
      if (record) records.push(record);
      continue;
    }
    for (const marker of markers) {
      const record = await readRecordFile(join(root, entry, marker), origin, textKey);
      if (record) {
        records.push(record);
        break;
      }
    }
  }
  return records;
}

async function discover(
  roots: Array<{ root: string; origin: 'project-local' | 'global' }>, markers: readonly string[], textKey: 'system_prompt' | 'steps',
): Promise<ReadRecord[]> {
  const seen = new Set<string>();
  const records: ReadRecord[] = [];
  for (const { root, origin } of roots) {
    for (const record of await scanDirectory(root, origin, markers, textKey)) {
      const key = record.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
    }
  }
  return records.sort((a, b) => {
    const originRank = a.origin === b.origin ? 0 : a.origin === 'project-local' ? -1 : 1;
    return originRank || a.name.localeCompare(b.name);
  });
}

export async function discoverPersonas(shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>): Promise<DiscoveredPersonaRecord[]> {
  const found = await discover(getPersonaDirectories(shellPaths.workingDirectory, shellPaths.homeDirectory), PERSONA_DIRECTORY_MARKERS, 'system_prompt');
  return found.map(({ text, ...record }) => ({ ...record, body: text }));
}

export async function discoverRoutines(shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>): Promise<DiscoveredRoutineRecord[]> {
  const found = await discover(getRoutineDirectories(shellPaths.workingDirectory, shellPaths.homeDirectory), ROUTINE_DIRECTORY_MARKERS, 'steps');
  return found.map(({ text, ...record }) => ({ ...record, steps: text }));
}

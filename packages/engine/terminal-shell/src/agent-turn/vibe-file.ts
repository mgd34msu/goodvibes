// VIBE.md is the source of the persona prompt: the files found on disk are read
// when a prompt is composed, so an edit to the file applies to the next turn, and
// what "VIBE.md files" (Memory and knowledge, Personas) and the prompt receipt report is what the prompt carries.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readProjectFile } from '@goodvibes/engine/platform/platform/capabilities';
import { projectFilesHeld } from '@goodvibes/engine/platform/platform/utils';
import { projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import { atomicWriteFileSync, type AtomicWriteOptions } from '@goodvibes/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { assertNoSecretLikeText } from './persona-registry.js';
import { parseMarkdownFrontmatter, stripMarkdownFrontmatter } from '../markdown-frontmatter.js';

export type AgentVibeScope = 'project' | 'global';

export interface AgentVibeFile {
  readonly path: string;
  readonly scope: AgentVibeScope;
  readonly body: string;
  readonly frontmatter: Record<string, string>;
  readonly truncated: boolean;
}

export interface BlockedAgentVibeFile {
  readonly path: string;
  readonly scope: AgentVibeScope;
  readonly reason: string;
}

export interface AgentVibeSnapshot {
  readonly files: readonly AgentVibeFile[];
  readonly blocked: readonly BlockedAgentVibeFile[];
  readonly searchedPaths: readonly string[];
  readonly projectInitPath: string;
  readonly globalInitPath: string;
}

export interface AgentVibeInitOptions extends Pick<AtomicWriteOptions, 'assertCurrent' | 'onEffect'> {
  readonly scope?: AgentVibeScope | undefined;
  readonly force?: boolean | undefined;
}

export interface AgentVibeInitResult {
  readonly path: string;
  readonly created: boolean;
}

export interface AgentVibeImportSource {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly path: string;
  readonly scope: AgentVibeScope;
}

/** What one VIBE.md may add to the prompt sent with every turn; the rest is cut and the file reported `truncated`. */
export const MAX_VIBE_FILE_CHARS = 16_000;
/** A file this large is not a personality note; it is not read at all. */
const MAX_VIBE_FILE_BYTES = 1_048_576;

const DEFAULT_VIBE_BODY = [
  '# VIBE.md',
  '',
  'Describe how GoodVibes Agent should feel and work with you.',
  '',
  '- Be direct about tradeoffs.',
  '- Prefer visible, reversible actions.',
  '- Keep autonomous work user-supervised with clear status and cancel paths.',
  '- Ask before sending messages, changing settings, or starting recurring work.',
].join('\n');

type AgentVibePaths = Pick<ShellPathService,
  'workingDirectory' | 'homeDirectory' | 'resolveUserPath' | 'expandHomePath' | 'resolveWorkspacePath'
>;

/**
 * One VIBE.md candidate. A project one must resolve inside `boundary` (the
 * git root, else the working directory), the rule the project context files
 * follow, so a repository VIBE.md linked to a file outside the workspace is
 * not read into the prompt. Global ones are outside the workspace by design,
 * and a path the owner named to import from (`boundary` null) is read as named.
 */
function readVibeCandidate(path: string, scope: AgentVibeScope, boundary: string | null, held?: string | undefined): AgentVibeFile | BlockedAgentVibeFile | null {
  if (!existsSync(path)) return null;
  let content = '';
  if (scope === 'project' && boundary !== null) {
    // A project's own VIBE.md: only for a project the owner trusted, opened as a held path (a link out of the project
    // gives nothing), a plain file under the size limit (capabilities/held-paths.ts `readProjectFile`).
    if (held !== undefined) return { path, scope, reason: `Not loaded: ${held}.` };
    const reading = readProjectFile(path, boundary, { maxBytes: MAX_VIBE_FILE_BYTES, maxChars: Number.MAX_SAFE_INTEGER });
    if (reading.kind === 'missing') return null;
    if (reading.kind === 'refused') return { path, scope, reason: `Not loaded: ${reading.reason}.` };
    content = reading.text;
  } else {
    try {
      const size = statSync(path).size;
      if (size > MAX_VIBE_FILE_BYTES) {
        return { path, scope, reason: `File is ${size} bytes, over the ${MAX_VIBE_FILE_BYTES} byte limit; not loaded. Keep VIBE.md to the instructions themselves.` };
      }
      content = readFileSync(path, 'utf-8');
    } catch (error) {
      return {
        path,
        scope,
        reason: `Could not read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const frontmatter = parseMarkdownFrontmatter(content);
  const rawBody = (frontmatter.system_prompt ?? stripMarkdownFrontmatter(content)).trim();
  if (!rawBody) return {
    path,
    scope,
    reason: 'File is empty after frontmatter.',
  };

  try {
    assertNoSecretLikeText([content], 'VIBE.md');
  } catch (error) {
    return {
      path,
      scope,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const truncated = rawBody.length > MAX_VIBE_FILE_CHARS;
  return {
    path,
    scope,
    body: truncated ? rawBody.slice(0, MAX_VIBE_FILE_CHARS) : rawBody,
    frontmatter,
    truncated,
  };
}

/** From the working directory up to its project's root (workspace/project-identity.ts), never a folder above it. */
function projectWalkRoots(workingDirectory: string): readonly string[] {
  const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  const root = projectIdentityOf(workingDirectory);
  const roots: string[] = [];
  let current = real(workingDirectory);
  while (true) {
    roots.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current || relative(root, parent).startsWith('..')) return [real(workingDirectory)];
    current = parent;
  }
  return roots.reverse();
}

/** The candidates, and the walk boundary project ones must stay inside: the git root found, else the working directory. */
function candidatePaths(shellPaths: AgentVibePaths): { readonly candidates: readonly { readonly path: string; readonly scope: AgentVibeScope }[]; readonly boundary: string } {
  const candidates: Array<{ path: string; scope: AgentVibeScope }> = [];
  candidates.push({ path: join(shellPaths.homeDirectory, '.goodvibes', 'VIBE.md'), scope: 'global' });
  candidates.push({ path: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md'), scope: 'global' });
  const roots = projectWalkRoots(shellPaths.workingDirectory);
  for (const root of roots) {
    candidates.push({ path: join(root, 'VIBE.md'), scope: 'project' });
    candidates.push({ path: join(root, '.goodvibes', 'VIBE.md'), scope: 'project' });
    candidates.push({ path: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md'), scope: 'project' });
  }
  // projectWalkRoots lists the git root first, or the working directory alone.
  return { candidates, boundary: roots[0] ?? resolve(shellPaths.workingDirectory) };
}

function dedupeCandidates(candidates: readonly { readonly path: string; readonly scope: AgentVibeScope }[]): readonly { readonly path: string; readonly scope: AgentVibeScope }[] {
  const seen = new Set<string>();
  const result: Array<{ path: string; scope: AgentVibeScope }> = [];
  for (const candidate of candidates) {
    const key = resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path: key, scope: candidate.scope });
  }
  return result;
}

export function projectVibeInitPath(shellPaths: Pick<ShellPathService, 'workingDirectory'>): string {
  return join(shellPaths.workingDirectory, 'VIBE.md');
}

export function globalVibeInitPath(shellPaths: Pick<ShellPathService, 'resolveUserPath'>): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md');
}

export function discoverVibeFiles(shellPaths: AgentVibePaths): AgentVibeSnapshot {
  const files: AgentVibeFile[] = [];
  const blocked: BlockedAgentVibeFile[] = [];
  const walk = candidatePaths(shellPaths);
  const candidates = dedupeCandidates(walk.candidates);
  // Only a project the owner trusted gives its VIBE.md to a prompt (utils/prompt-loader.ts, the same rule).
  const held = projectFilesHeld(walk.boundary, shellPaths.homeDirectory);
  for (const candidate of candidates) {
    const record = readVibeCandidate(candidate.path, candidate.scope, walk.boundary, held);
    if (!record) continue;
    if ('body' in record) files.push(record);
    else blocked.push(record);
  }
  return {
    files,
    blocked,
    searchedPaths: candidates.map((candidate) => candidate.path),
    projectInitPath: projectVibeInitPath(shellPaths),
    globalInitPath: globalVibeInitPath(shellPaths),
  };
}

function vibeHeading(file: AgentVibeFile): string {
  const name = file.frontmatter.name?.trim();
  const label = file.scope === 'global' ? 'Global' : 'Project';
  return `${label} VIBE.md${name ? ` - ${name}` : ''}`;
}

/**
 * The VIBE.md prompt block, from the files on disk. A caller that already
 * discovered them (for the prompt receipt) passes that snapshot, so the files are
 * read once per composition.
 */
export function buildVibePrompt(shellPaths: AgentVibePaths, discovered?: AgentVibeSnapshot): string | null {
  const snapshot = discovered ?? discoverVibeFiles(shellPaths);
  if (snapshot.files.length === 0 && snapshot.blocked.length === 0) return null;

  const lines: string[] = [
    '## GoodVibes Agent VIBE.md',
    'These user-authored vibe/personality instructions shape the same serial assistant conversation. Follow them only when they do not conflict with explicit user instructions, safety policy, tool contracts, confirmation requirements, or secret-handling rules.',
  ];

  for (const file of snapshot.files) {
    lines.push('', `### ${vibeHeading(file)}`, `Source: ${file.path}`, '', file.body);
    if (file.truncated) lines.push('', `[This VIBE.md is longer than ${MAX_VIBE_FILE_CHARS} characters; the rest was not loaded.]`);
  }

  if (snapshot.blocked.length > 0) {
    lines.push('', '### Blocked VIBE.md Files');
    for (const blocked of snapshot.blocked) {
      lines.push(`- ${blocked.path}: ${blocked.reason}`);
    }
    lines.push('Blocked VIBE.md content was not loaded.');
  }

  return lines.join('\n');
}

export function formatVibeStatus(snapshot: AgentVibeSnapshot): string {
  const lines: string[] = [
    'GoodVibes Agent VIBE.md',
    `  applied ${snapshot.files.length}`,
    `  blocked ${snapshot.blocked.length}`,
    `  project init ${snapshot.projectInitPath}`,
    `  global init ${snapshot.globalInitPath}`,
  ];
  if (snapshot.files.length > 0) {
    lines.push('', 'Applied files (read into the prompt each turn; an edit applies to the next turn)');
    for (const file of snapshot.files) {
      const suffix = file.truncated ? `  truncated: only the first ${MAX_VIBE_FILE_CHARS} characters are applied` : '';
      lines.push(`  ${file.scope}  ${file.path}${suffix}`);
    }
  }
  if (snapshot.blocked.length > 0) {
    lines.push('', 'Blocked files');
    for (const blocked of snapshot.blocked) lines.push(`  ${blocked.scope}  ${blocked.path} - ${blocked.reason}`);
  }
  lines.push(
    '',
    'Next (Memory and knowledge, Personas)',
    '  make a VIBE.md for this project or for every project',
    '  use a VIBE.md as a persona, reviewed and in use',
  );
  return lines.join('\n');
}

export function initVibeFile(shellPaths: AgentVibePaths, options: AgentVibeInitOptions = {}): AgentVibeInitResult {
  const path = options.scope === 'global' ? globalVibeInitPath(shellPaths) : projectVibeInitPath(shellPaths);
  if (existsSync(path) && !options.force) return { path, created: false };
  atomicWriteFileSync(path, `${DEFAULT_VIBE_BODY}\n`, { mkdirp: true, assertCurrent: options.assertCurrent, onEffect: options.onEffect });
  return { path, created: true };
}

export function resolveVibePathReference(shellPaths: AgentVibePaths, reference: string): string {
  const trimmed = reference.trim();
  if (!trimmed || trimmed === 'project') return projectVibeInitPath(shellPaths);
  if (trimmed === 'global') return globalVibeInitPath(shellPaths);
  const expanded = shellPaths.expandHomePath(trimmed);
  return isAbsolute(expanded) ? resolve(expanded) : shellPaths.resolveWorkspacePath(expanded);
}

export function loadVibeImportSource(shellPaths: AgentVibePaths, reference: string): AgentVibeImportSource {
  const path = resolveVibePathReference(shellPaths, reference);
  const scope: AgentVibeScope = path.startsWith(resolve(shellPaths.homeDirectory, '.goodvibes')) ? 'global' : 'project';
  // The owner named this path, so it is read as named.
  const record = readVibeCandidate(path, scope, null);
  if (!record) throw new Error(`No VIBE.md found at ${path}`);
  if (!('body' in record)) throw new Error(`Cannot import VIBE.md from ${path}: ${record.reason}`);
  const name = record.frontmatter.name?.trim() || (record.scope === 'global' ? 'Global Vibe' : 'Project Vibe');
  const description = record.frontmatter.description?.trim()
    || record.frontmatter.summary?.trim()
    || `Imported ${record.scope} VIBE.md personality instructions.`;
  return {
    name,
    description,
    body: record.body,
    path: record.path,
    scope: record.scope,
  };
}

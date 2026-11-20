// VIBE.md is the source of the persona prompt: the files found on disk are read
// when a prompt is composed, so an edit to the file applies to the next turn, and
// what `/personas vibe` and the prompt receipt report is what the prompt carries.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicWriteFileSync, type AtomicWriteOptions } from '@goodvibes-jev/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
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

function readVibeCandidate(path: string, scope: AgentVibeScope): AgentVibeFile | BlockedAgentVibeFile | null {
  if (!existsSync(path)) return null;
  let content = '';
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

function projectWalkRoots(workingDirectory: string): readonly string[] {
  const roots: string[] = [];
  let current = resolve(workingDirectory);
  let foundGitRoot = false;
  while (true) {
    roots.push(current);
    if (existsSync(join(current, '.git'))) {
      foundGitRoot = true;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!foundGitRoot) return [resolve(workingDirectory)];
  return roots.reverse();
}

function candidatePaths(shellPaths: AgentVibePaths): readonly { readonly path: string; readonly scope: AgentVibeScope }[] {
  const candidates: Array<{ path: string; scope: AgentVibeScope }> = [];
  candidates.push({ path: join(shellPaths.homeDirectory, '.goodvibes', 'VIBE.md'), scope: 'global' });
  candidates.push({ path: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md'), scope: 'global' });
  for (const root of projectWalkRoots(shellPaths.workingDirectory)) {
    candidates.push({ path: join(root, 'VIBE.md'), scope: 'project' });
    candidates.push({ path: join(root, '.goodvibes', 'VIBE.md'), scope: 'project' });
    candidates.push({ path: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md'), scope: 'project' });
  }
  return candidates;
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
  const candidates = dedupeCandidates(candidatePaths(shellPaths));
  for (const candidate of candidates) {
    const record = readVibeCandidate(candidate.path, candidate.scope);
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
    'Next',
    '  /personas vibe-create',
    '  /personas vibe-create global',
    '  /personas vibe-import project --review --use',
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
  const record = readVibeCandidate(path, scope);
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

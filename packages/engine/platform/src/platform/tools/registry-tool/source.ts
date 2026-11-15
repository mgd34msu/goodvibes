/** Registry modes share one reader; captured readers never fall back to live files. */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  collectMarkdownReferences, extractMarkdownPreview, extractMarkdownSections,
  parseMarkdownFrontmatter, type MarkdownDisclosure,
} from '../../utils/markdown-disclosure.js';

export interface RegistryToolSource {
  /** True for the live file-system source, whose judgments need no per-candidate serialisation. */
  readonly live?: true | undefined;
  readonly signal?: AbortSignal | undefined;
  exists(path: string): Promise<boolean>;
  includeExists(path: string): Promise<boolean>;
  list(path: string): Promise<readonly string[]>;
  read(path: string): Promise<string>;
  assertCurrent(): Promise<void>;
}
export interface LiveRegistryRoots {
  readonly workingDirectory: string;
  readonly homeDirectory?: string | undefined;
}

/** The only directories a live registry read may reach: `.goodvibes/{skills,agents}` of the project and of the home directory. */
export function liveRegistryScope(roots: LiveRegistryRoots): string[] {
  const owners = [roots.workingDirectory, ...(roots.homeDirectory ? [roots.homeDirectory] : [])];
  return owners.flatMap((owner) => ['skills', 'agents'].map((kind) => join(owner, '.goodvibes', kind)));
}

function realOrUndefined(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

/**
 * True when `path`, after resolving every `..` and symlink, lies inside one of
 * the scope directories. A path that does not exist is never contained.
 */
export function isInsideLiveRegistryScope(scope: readonly string[], path: string): boolean {
  const real = realOrUndefined(resolve(path));
  if (real === undefined) return false;
  return scope.some((root) => {
    const realRoot = realOrUndefined(root);
    if (realRoot === undefined) return false;
    const rel = relative(realRoot, real);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  });
}

/** A live source whose reads, listings and includes stay inside the scope; escaping paths read as absent or are refused. */
export function createLiveRegistrySource(roots: LiveRegistryRoots): RegistryToolSource {
  const scope = liveRegistryScope(roots);
  const assertInside = (path: string): void => {
    if (!isInsideLiveRegistryScope(scope, path)) {
      throw new Error(`registry source ${resolve(path)} is outside .goodvibes/skills and .goodvibes/agents`);
    }
  };
  return {
    live: true,
    exists: async (path) => existsSync(path),
    includeExists: async (path) => {
      if (!existsSync(path)) return false;
      assertInside(path);
      return true;
    },
    list: async (path) => { assertInside(path); return readdirSync(path); },
    read: async (path) => { assertInside(path); return readFileSync(path, 'utf8'); },
    assertCurrent: async () => undefined,
  };
}

export async function registryMarkdown(source: RegistryToolSource, path: string): Promise<MarkdownDisclosure> {
  const { metadata, body } = parseMarkdownFrontmatter(await source.read(path));
  return {
    path: resolve(path), metadata, body,
    includes: collectMarkdownReferences(body), sections: extractMarkdownSections(body),
    preview: extractMarkdownPreview(body),
  };
}

/** Same five-level/cycle/escaped-marker contract as markdown-disclosure's live reader. */
export async function materializeRegistryMarkdown(
  source: RegistryToolSource, path: string, body: string, visited = new Set<string>(), depth = 0,
): Promise<string> {
  path = resolve(path);
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
    if (!await source.includeExists(target)) continue;
    const disclosure = await registryMarkdown(source, target);
    const content = await materializeRegistryMarkdown(source, target, disclosure.body, visited, depth + 1);
    if (content) result.push(content);
  }
  return result.join('\n');
}

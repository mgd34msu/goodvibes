/** Original-owner registry inputs, admitted by the host, never by model paths. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority, contractInputAuthoritySourceRoot,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import type { ReadAccessFilter } from '../shared/read-access.js';
import { liveRegistryScope, type RegistryToolSource } from './source.js';

export interface CapturedRegistryContext { readonly kind: 'captured-registry-context' }
export interface CapturedRegistryBinding {
  readonly authority: ContractInputAuthority;
  readonly root: string;
  readonly readAccessFilter: ReadAccessFilter | undefined;
  readonly signal?: AbortSignal | undefined;
}
interface CapturedFile { readonly fingerprint: string }
interface Admission {
  readonly authority: ContractInputAuthority;
  readonly workingDirectory: string;
  readonly homeDirectory: string | undefined;
  readonly surfaceRoot: string | undefined;
  readonly source: (signal?: AbortSignal) => RegistryToolSource;
}
const admissions = new WeakMap<CapturedRegistryContext, Admission>();
const fingerprint = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
const identity = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;
const contained = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};

/**
 * Configured home is a host declaration, not a grant; every file uses the pinned host filter.
 * Capture only the skill folders (.goodvibes/skills and .goodvibes/<surface>/skills) and
 * .goodvibes/agents below the admitted owner/configured home.
 * Other .goodvibes paths and symlinks remain unavailable. Included files may have
 * any extension, but an excluded/restricted/out-of-scope include holds content.
 * Capture metadata for the complete registry; read bytes on demand under the
 * same identity and owner checks, so unrelated large files cannot block discovery.
 */
export async function admitCapturedRegistryContext(
  binding: CapturedRegistryBinding,
  roots: { readonly homeDirectory?: string | undefined; readonly surfaceRoot?: string | undefined } = {},
): Promise<CapturedRegistryContext> {
  binding = Object.freeze({ authority: binding.authority, root: resolve(binding.root), readAccessFilter: binding.readAccessFilter, signal: binding.signal });
  // Capture all caller-owned inputs before the first callback/await.
  // Owner roots are resolved through symlinks once, here: every admitted path is compared with its own real path,
  // so a root reached through a symlinked ancestor (for example /home -> /var/home) would otherwise withhold everything below it.
  const realRoot = (path: string): string => { try { return realpathSync(resolve(path)); } catch { return resolve(path); } };
  const homeDirectory = roots.homeDirectory === undefined ? undefined : realRoot(roots.homeDirectory);
  const workingDirectory = realRoot(contractInputAuthoritySourceRoot(binding.authority));
  const filter = binding.readAccessFilter;
  if (!filter) throw new Error('registry input requires original-owner read authorization');
  const surfaceRoot = roots.surfaceRoot?.trim() ? roots.surfaceRoot : undefined;
  // The same directories a live session reads, from the one list of skill and agent roots.
  const declared = [...new Set(liveRegistryScope({ workingDirectory, homeDirectory, surfaceRoot }))];
  const files = new Map<string, CapturedFile>();
  const directories = new Map<string, readonly string[]>();
  const directoryIdentities = new Map<string, string>();
  const used = new Set<string>();
  const withheld = new Set<string>();
  const inScope = (path: string): boolean => declared.some((root) => contained(root, path) &&
    !relative(root, path).split(sep).some((part) => CONTRACT_INPUT_EXCLUSIONS.includes(part as typeof CONTRACT_INPUT_EXCLUSIONS[number])));
  const checkPath = (path: string): void => {
    if (!inScope(path) || realpathSync(path) !== path) throw new Error('registry source is outside its admitted roots or redirected');
    for (const [directory, expected] of directoryIdentities) {
      if (!contained(directory, path)) continue;
      const stat = lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== expected)
        throw new Error('registry source directory identity changed');
    }
    const file = files.get(path);
    if (file && fingerprint(lstatSync(path, { bigint: true })) !== file.fingerprint)
      throw new Error('registry source changed after admission');
  };
  const checkAuthority = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
    signal?.throwIfAborted();
  };
  const checkRead = async (path: string, signal?: AbortSignal): Promise<void> => {
    await checkAuthority(signal);
    checkPath(path);
    if (!await filter(path)) throw new Error('registry source is access-restricted');
    await checkAuthority(signal);
    checkPath(path);
  };
  // The owner's view is proved at the start and end of a call: one authority
  // check each, and an lstat of every file the call used. Read access was asked
  // when each file was read and is not asked again.
  const checkUsed = async (signal?: AbortSignal): Promise<void> => {
    await checkAuthority(signal);
    for (const path of used) checkPath(path);
  };
  const visit = async (path: string, depth: number): Promise<void> => {
    if (!inScope(path)) { withheld.add(path); return; }
    let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || realpathSync(path) !== path) { withheld.add(path); return; }
    if (!await filter(path)) { withheld.add(path); return; }
    await checkAuthority();
    checkPath(path);
    if (stat.isDirectory()) {
      directoryIdentities.set(path, identity(stat));
      const entries = readdirSync(path).sort();
      directories.set(path, Object.freeze(entries));
      for (const entry of entries) await visit(join(path, entry), depth + 1);
    } else if (stat.isFile()) {
      files.set(path, { fingerprint: fingerprint(stat) });
      await checkRead(path);
    }
  };
  await checkAuthority();
  for (const directory of declared) await visit(directory, 0);
  await checkAuthority();
  const token = Object.freeze({ kind: 'captured-registry-context' as const });
  const admission: Admission = {
    authority: binding.authority, workingDirectory, homeDirectory, surfaceRoot,
    source: (signal) => {
      // Inside one call the authority was proved when the call began (assertCurrent);
      // each read checks its own path and access, and the call ends with assertCurrent again.
      const allowed = new Set<string>();
      const readOnce = async (path: string): Promise<void> => {
        signal?.throwIfAborted();
        checkPath(path);
        if (!allowed.has(path)) {
          if (!await filter(path)) throw new Error('registry source is access-restricted');
          allowed.add(path);
        }
      };
      return {
        signal: binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : (binding.signal ?? signal),
        exists: async (raw) => { signal?.throwIfAborted(); return files.has(resolve(raw)) || directories.has(resolve(raw)); },
        includeExists: async (raw) => {
          signal?.throwIfAborted();
          const path = resolve(raw);
          if (!inScope(path) || [...withheld].some((blocked) => contained(blocked, path)))
            throw new Error('registry include was not admitted; content is withheld');
          return files.has(path) || directories.has(path);
        },
        list: async (raw) => {
          const path = resolve(raw);
          used.add(path);
          await readOnce(path);
          const entries = directories.get(path);
          if (!entries) throw new Error('registry directory was not admitted');
          return entries;
        },
        read: async (raw) => {
          const path = resolve(raw);
          const file = files.get(path);
          if (!file) throw new Error('registry file was not admitted');
          used.add(path);
          await readOnce(path);
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let data: string;
          try {
            if (fingerprint(fstatSync(fd, { bigint: true })) !== file.fingerprint) throw new Error('registry source changed during read');
            data = readFileSync(fd, 'utf8');
            if (fingerprint(fstatSync(fd, { bigint: true })) !== file.fingerprint) throw new Error('registry source changed during read');
          } finally { closeSync(fd); }
          return data;
        },
        assertCurrent: () => checkUsed(signal),
      };
    },
  };
  admissions.set(token, Object.freeze(admission));
  return token;
}

export function capturedRegistryAdmission(context: CapturedRegistryContext): Admission {
  const state = admissions.get(context);
  if (!state) throw new Error('registry input has no construction-owned admission');
  return state;
}

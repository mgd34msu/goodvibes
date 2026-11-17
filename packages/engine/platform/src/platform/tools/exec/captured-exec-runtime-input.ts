import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/**
 * Trusted Node runtime for captured commands, separate from model arguments
 * and project dependencies. The node executable and the npm package it runs
 * are pinned at construction (path, canonical path and stat identity) and
 * mounted read-only at /captured-runtime; nothing is copied. Every command
 * compares the pinned identities again (a few `lstat` calls).
 */
import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertContractInputAuthority, contractInputAuthorityRoot, registerContractInputReadAssertion } from '../../contract/input-authority.js';
import type { CapturedExecAuthority } from './captured-exec.js';

type Binding = Pick<CapturedExecAuthority, 'authority' | 'root' | 'readAccessFilter' | 'signal' | 'retainInputResource'>;
export interface CapturedExecNodeRuntimeDeclaration {
  readonly nodeExecutable: string;
  readonly npmExecutable: string;
  readonly npxExecutable: string;
}
export interface CapturedExecNodeRuntimeInput { readonly kind: 'captured-exec-node-runtime' }
const TARGET = '/captured-runtime/node';
interface Pinned { readonly source: string; readonly canonical: string; readonly identity: string }
const states = new WeakMap<CapturedExecNodeRuntimeInput, {
  readonly binding: Binding;
  readonly node: string;
  readonly packageRoot: string;
  readonly check: (signal?: AbortSignal) => Promise<void>;
}>();
const identity = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): string =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}`;
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};
/** The first executable `name` on the trusted PATH (absolute entries only). */
function findExecutable(name: string, path: string): string {
  for (const directory of path.split(sep === '/' ? ':' : ';')) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Next trusted PATH entry. */ }
  }
  throw new Error(`Captured validators require an installed ${name} executable on the trusted runtime PATH.`);
}

/** Captured commands and validators can defer the runtime until execution.
 * PATH resolution and executable identities are pinned synchronously at construction.
 * A failed/cancelled first admission is terminal; this is not another retry loop.
 */
export function createCapturedExecNodeRuntimeAdmission(
  binding: Binding,
  declaration?: CapturedExecNodeRuntimeDeclaration,
): (signal?: AbortSignal) => Promise<CapturedExecNodeRuntimeInput> {
  binding = Object.freeze({ ...binding });
  const trustedPath = process.env.PATH ?? '';
  let pinned: CapturedExecNodeRuntimeDeclaration | undefined;
  let initialError: unknown;
  try {
    const find = (name: string): string => findExecutable(name, trustedPath);
    pinned = Object.freeze(declaration ? { ...declaration } : {
      nodeExecutable: find('node'), npmExecutable: find('npm'), npxExecutable: find('npx'),
    });
  } catch (error) { initialError = error; }
  let admission: Promise<CapturedExecNodeRuntimeInput> | undefined;
  return (signal?: AbortSignal) => {
    admission ??= (async () => {
      if (initialError) throw initialError;
      if (!pinned) throw new Error('Node runtime declaration is unavailable');
      // The admission is shared by every command of this owner, so it runs under
      // the owner's lifetime only. One caller's cancel stops that caller's wait
      // (executePolicyCheck below), never the admission the next command reuses.
      return admitCapturedExecNodeRuntime(binding, pinned);
    })();
    return executePolicyCheck(() => admission!, signal);
  };
}

/** Call only during trusted construction. Never accept this declaration from tool JSON. */
export async function admitCapturedExecNodeRuntime(
  binding: Binding,
  declaration?: CapturedExecNodeRuntimeDeclaration,
): Promise<CapturedExecNodeRuntimeInput> {
  binding = Object.freeze({ ...binding });
  const trustedPath = process.env.PATH ?? '';
  const filter = binding.readAccessFilter;
  if (!filter) throw new Error('Node runtime requires original-owner read authorization');
  await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
  const declared = declaration ?? {
    nodeExecutable: findExecutable('node', trustedPath),
    npmExecutable: findExecutable('npm', trustedPath),
    npxExecutable: findExecutable('npx', trustedPath),
  };
  if (Object.values(declared).some((path) => !isAbsolute(path))) throw new Error('Node runtime declarations must be absolute');
  const pin = (source: string): Pinned => {
    const canonical = realpathSync(source);
    return { source, canonical, identity: identity(lstatSync(canonical, { bigint: true })) };
  };
  const node = pin(declared.nodeExecutable), npm = pin(declared.npmExecutable), npx = pin(declared.npxExecutable);
  if (!lstatSync(node.canonical).isFile()) throw new Error('Node runtime must be an executable file');
  const packageRoot = dirname(dirname(npm.canonical));
  if (npm.canonical !== join(packageRoot, 'bin/npm-cli.js') || npx.canonical !== join(packageRoot, 'bin/npx-cli.js'))
    throw new Error('Node runtime npm/npx must belong to the same declared npm package');
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown };
  if (metadata.name !== 'npm') throw new Error('Declared runtime package is not npm');
  const packageStat = await lstat(packageRoot, { bigint: true });
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new Error('Declared npm package is not a directory');
  const packageIdentity = `${packageStat.dev}:${packageStat.ino}`;
  const pins = [node, npm, npx];
  const check = async (signal: AbortSignal | undefined = binding.signal): Promise<void> => {
    signal = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
    signal?.throwIfAborted();
    if (contractInputAuthorityRoot(binding.authority) !== resolve(binding.root)) throw new Error('Node runtime authority changed');
    for (const read of pins) {
      if (await realpath(read.source) !== read.canonical || identity(await lstat(read.canonical, { bigint: true })) !== read.identity)
        throw new Error('Node runtime executable changed since trusted construction');
    }
    const stat = await lstat(packageRoot, { bigint: true });
    if (`${stat.dev}:${stat.ino}` !== packageIdentity) throw new Error('Declared npm package changed since trusted construction');
    for (const path of [node.source, node.canonical, packageRoot]) {
      if (!await executePolicyCheck(() => filter(path), signal)) throw new Error('Node runtime input is access-restricted');
    }
    signal?.throwIfAborted();
  };
  await check();
  const token = Object.freeze({ kind: 'captured-exec-node-runtime' as const });
  states.set(token, { binding, node: node.canonical, packageRoot, check });
  registerContractInputReadAssertion(binding.authority, check);
  return token;
}

/** Replace only the existing OS command aliases, never mount another runtime tree. */
function blockedSystemRuntimeAliases(refusal: string): string[] {
  const argv: string[] = [];
  const targets = new Set<string>();
  for (const name of ['node', 'nodejs', 'npm', 'npx']) {
    const alias = `/usr/bin/${name}`;
    if (!existsSync(alias)) continue;
    const target = realpathSync(alias);
    if (!['/usr/bin', '/usr/lib', '/usr/lib64'].some((root) => within(root, target)) || targets.has(target)) continue;
    targets.add(target);
    argv.push('--ro-bind', refusal, target);
  }
  return argv;
}

export async function projectCapturedExecNodeRuntime(binding: CapturedExecAuthority, temporary: string, signal?: AbortSignal): Promise<{
  argv: string[]; check: (signal?: AbortSignal) => Promise<void>;
}> {
  if (!binding.nodeRuntimeInput && !binding.nodeRuntimeAdmission) return { argv: [], check: async () => {} };
  signal = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
  signal?.throwIfAborted();
  // Only the admitted /captured-runtime aliases carry runtime authority. Never
  // fall through to a different Node/npm installation in the OS substrate.
  const refusal = join(temporary, 'node-runtime-unavailable');
  await writeFile(refusal, '#!/bin/sh\nprintf "%s\\n" "Captured Node/npm runtime is unavailable or access-restricted." >&2\nexit 126\n', { mode: 0o755 });
  await chmod(refusal, 0o755);
  signal?.throwIfAborted();
  if (!binding.nodeRuntimeInput) {
    return { check: async () => {}, argv: [
      ...['node', 'npm', 'npx'].flatMap((name) => ['--ro-bind', refusal, `/captured-runtime/bin/${name}`]),
      ...blockedSystemRuntimeAliases(refusal),
    ] };
  }
  const state = states.get(binding.nodeRuntimeInput);
  if (!state || state.binding.authority !== binding.authority || state.binding.root !== binding.root || state.binding.readAccessFilter !== binding.readAccessFilter)
    throw new Error('Node runtime has no matching construction-owned admission');
  await state.check(signal);
  return { check: () => state.check(signal), argv: [
    '--ro-bind', state.node, `${TARGET}/bin/node`,
    '--ro-bind', state.packageRoot, `${TARGET}/lib/node_modules/npm`,
    '--symlink', `${TARGET}/bin/node`, '/captured-runtime/bin/node',
    '--symlink', `${TARGET}/lib/node_modules/npm/bin/npm-cli.js`, '/captured-runtime/bin/npm',
    '--symlink', `${TARGET}/lib/node_modules/npm/bin/npx-cli.js`, '/captured-runtime/bin/npx',
    ...blockedSystemRuntimeAliases(refusal)] };
}

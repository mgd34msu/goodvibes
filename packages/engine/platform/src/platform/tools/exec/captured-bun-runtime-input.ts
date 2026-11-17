/**
 * Ordinary Bun is an explicit, pinned runtime input, never a PATH fallback.
 * The executable is pinned at construction (canonical path and stat identity),
 * proven an ordinary interpreter once in an empty boundary, and mounted
 * read-only at /captured-runtime/bin/bun; nothing is copied. Every command
 * compares the pinned identity again (one `realpath`, one `lstat`).
 */
import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { assertContractInputAuthority, contractInputAuthorityRoot, registerContractInputReadAssertion } from '../../contract/input-authority.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { resolveProcessCapturedBunRuntimeExecutable } from '../../runtime/captured-bun-runtime.js';
import { probeCapturedBunRuntime, type CapturedExecAuthority } from './captured-exec.js';

type Binding = Pick<CapturedExecAuthority, 'authority' | 'root' | 'readAccessFilter' | 'signal' | 'retainInputResource'>;
export interface CapturedExecBunRuntimeDeclaration { readonly bunExecutable: string }
export interface CapturedExecBunRuntimeInput { readonly kind: 'captured-exec-bun-runtime' }
const TARGET = '/captured-runtime/bin/bun';
const states = new WeakMap<CapturedExecBunRuntimeInput, {
  readonly binding: Binding;
  readonly canonical: string;
  readonly check: (signal?: AbortSignal) => Promise<void>;
}>();
const identity = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): string =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}`;

/** Construction only. Source mode admits its running interpreter; compiled
 * products must supply their packaged ordinary Bun executable explicitly.
 * Missing, changed and failed first admissions are terminal for this owner;
 * a caller cancelling its own wait is not one.
 */
export function createCapturedExecBunRuntimeAdmission(
  binding: Binding,
  declaration?: CapturedExecBunRuntimeDeclaration,
): (signal?: AbortSignal) => Promise<CapturedExecBunRuntimeInput> {
  binding = Object.freeze({ ...binding });
  const source = declaration?.bunExecutable ?? process.execPath;
  let pinned: { canonical: string; identity: string } | undefined;
  let initialError: unknown;
  try {
    if (!isAbsolute(source)) throw new Error('Bun runtime declaration must be absolute');
    accessSync(source, constants.X_OK);
    const canonical = realpathSync(source);
    const stat = lstatSync(canonical, { bigint: true });
    if (!stat.isFile()) throw new Error('Bun runtime must be an executable file');
    pinned = { canonical, identity: identity(stat) };
  } catch (error) { initialError = error; }
  let admission: Promise<CapturedExecBunRuntimeInput> | undefined;
  return (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    admission ??= (async () => {
      if (initialError) throw initialError;
      if (!pinned) throw new Error('Bun runtime declaration is unavailable');
      const original = pinned;
      const filter = binding.readAccessFilter;
      if (!filter) throw new Error('Bun runtime requires original-owner read authorization');
      // One admission serves every call of this owner, so it runs under the owner's signal only.
      // A caller's own signal cancels that caller's wait (executePolicyCheck below), never the shared work:
      // otherwise one cancelled first call would leave a rejected promise for every later call.
      const check = async (current: AbortSignal | undefined = binding.signal): Promise<void> => {
        current = binding.signal && current ? AbortSignal.any([binding.signal, current]) : binding.signal ?? current;
        current?.throwIfAborted();
        if (contractInputAuthorityRoot(binding.authority) !== resolve(binding.root)) throw new Error('Bun runtime authority changed');
        if (await realpath(source) !== original.canonical || identity(await lstat(original.canonical, { bigint: true })) !== original.identity)
          throw new Error('Bun runtime executable changed since trusted construction');
        for (const path of [source, original.canonical]) {
          if (!await executePolicyCheck(() => filter(path), current)) throw new Error('Bun runtime input is access-restricted');
        }
        current?.throwIfAborted();
      };
      await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
      await check();
      // This proof sees no project mount or host configuration, and receives
      // no BUN_BE_BUN marker. A product executable is not an interpreter.
      if (!await probeCapturedBunRuntime(original.canonical, binding.signal)) throw new Error('Declared Bun runtime is not an available ordinary interpreter');
      await check();
      const token = Object.freeze({ kind: 'captured-exec-bun-runtime' as const });
      states.set(token, { binding, canonical: original.canonical, check });
      registerContractInputReadAssertion(binding.authority, check);
      return token;
    })();
    return executePolicyCheck(() => admission!, signal);
  };
}

export async function projectCapturedExecBunRuntime(binding: CapturedExecAuthority, temporary: string, signal?: AbortSignal): Promise<{
  argv: string[]; check: (signal?: AbortSignal) => Promise<void>;
}> {
  if (!binding.bunRuntimeInput && !binding.bunRuntimeAdmission && resolveProcessCapturedBunRuntimeExecutable() === process.execPath)
    return { argv: [], check: async () => {} };
  signal = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
  signal?.throwIfAborted();
  const state = binding.bunRuntimeInput ? states.get(binding.bunRuntimeInput) : undefined;
  if (binding.bunRuntimeInput && (!state || state.binding.authority !== binding.authority || state.binding.root !== binding.root || state.binding.readAccessFilter !== binding.readAccessFilter))
    throw new Error('Bun runtime has no matching construction-owned admission');
  await state?.check(signal);
  signal?.throwIfAborted();
  // Only the pinned /captured-runtime alias carries Bun authority. An absent
  // or denied runtime leaves shell/Node usable, without invoking the compiled
  // product or another interpreter supplied by the OS substrate.
  const refusal = join(temporary, 'bun-runtime-unavailable');
  await writeFile(refusal, '#!/bin/sh\nprintf "%s\\n" "Captured Bun runtime is unavailable or access-restricted." >&2\nexit 126\n', { mode: 0o755 });
  await chmod(refusal, 0o755);
  signal?.throwIfAborted();
  const aliases: string[] = [];
  const targets = new Set<string>();
  for (const name of ['bun', 'bunx']) {
    const alias = `/usr/bin/${name}`;
    if (!existsSync(alias)) continue;
    const target = realpathSync(alias);
    if (!['/usr/bin', '/usr/lib', '/usr/lib64'].some((root) => {
      const path = relative(root, target);
      return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
    }) || targets.has(target)) continue;
    targets.add(target);
    aliases.push('--ro-bind', refusal, target);
  }
  if (!state) return { argv: ['--ro-bind', refusal, TARGET, ...aliases], check: async () => {} };
  return { check: () => state.check(signal), argv: ['--ro-bind', state.canonical, TARGET, ...aliases] };
}

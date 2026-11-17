import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { isClassicOperation } from '../../runtime/decision-policy.js';
/** Captured repair: contained candidates, then the existing parser/Jev acceptance. */
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { assertContractInputAuthority, registerContractInputCleanup } from '../../contract/input-authority.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { runCapturedCommand, type CapturedExecAuthority } from '../exec/captured-exec.js';
import { AutoHealer, type HealResult } from './auto-heal.js';
import { resolveLanguages, type ResolvedLanguages } from '../../intelligence/config.js';
import { createShellPathService } from '../../runtime/shell-paths.js';
import { assertCapturedPublicationOwner } from './captured-publication.js';
import { assertCapturedWriteRevision } from './captured-write-revision.js';
import { StaleError } from '../../utils/revision.js';
import { assertCapturedToolAccessCurrent, assertCapturedToolMutationCurrent, assertCapturedToolReadAccess, capturedToolPublicationContext, captureCapturedToolWriteRevision, hasCapturedToolInvocation } from './captured-input-tools.js';

export interface CapturedAutoHealBackend { readonly kind: 'captured-auto-heal-backend' }
const backends = new WeakMap<CapturedAutoHealBackend, CapturedExecAuthority>();
export function createCapturedAutoHealBackend(binding: CapturedExecAuthority): CapturedAutoHealBackend {
  const backend = Object.freeze({ kind: 'captured-auto-heal-backend' as const });
  backends.set(backend, Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined }));
  return backend;
}
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The workspace's language files, for the formatter and linter they set. The
 * config manager the tools are built with knows the home and working
 * directories; a narrower one (tests, embedders) means the built-in tools only.
 */
function workspaceLanguages(config: HealConfig): () => ResolvedLanguages | undefined {
  let resolved: ResolvedLanguages | undefined | null = null;
  return () => {
    if (resolved !== null) return resolved;
    const home = config.getHomeDirectory?.();
    const workingDirectory = config.getWorkingDirectory?.();
    resolved = home && workingDirectory ? resolveLanguages(createShellPathService({ workingDirectory, homeDirectory: home })) : undefined;
    return resolved;
  };
}

type HealConfig = Pick<ConfigManager, 'get'>
  & Partial<Pick<ConfigManager, 'getHomeDirectory' | 'getWorkingDirectory' | 'onDidChangeIncarnation' | 'revisionSource'>>;

/**
 * Aborts the heal when the settings that admitted the write change: the owner's
 * own change event, so a provider call or formatter in flight stops at once and
 * nothing polls. Whether the call is still wanted is the invocation's signal,
 * already joined to the heal's signal.
 */
function abortOnSettingsChange(config: HealConfig, operation: AbortController): () => void {
  const source = config.revisionSource;
  if (!config.onDidChangeIncarnation || !source) return () => {};
  const captured = source.revision();
  return config.onDidChangeIncarnation(() => {
    if (!operation.signal.aborted) operation.abort(new StaleError(source, captured, source.revision()));
  });
}

/** Returning a repair never itself authorizes a write. Recheck immediately before publication. */
export async function healToolFile(
  config: HealConfig,
  llm: Pick<ToolLLM, 'chat'>,
  path: string,
  content: string,
  errors: string[],
  backend?: CapturedAutoHealBackend,
  assertInvocation?: () => void,
  invocationSignal?: AbortSignal,
): Promise<HealResult & { assertCurrent: () => Promise<void>; assertCurrentSynchronous: () => void }> {
  assertInvocation?.();
  if (!hasCapturedToolInvocation()) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(invocationSignal ? [invocationSignal] : [])]);
    const assertSource = () => { signal.throwIfAborted(); assertInvocation?.(); };
    const reading = !isClassicOperation() && assertInvocation && config.get('tools.autoHeal') && errors.length ? captureJudgmentPort('tools.auto-heal.acceptance', { signal, assertCurrent: assertSource }) : undefined;
    const check = () => { assertSource(); reading?.assertCurrent(); };
    const stopWatching = abortOnSettingsChange(config, controller);
    try {
      const result = await executePolicyCheck(() => new AutoHealer(config, llm, undefined, check, signal, reading, workspaceLanguages(config), () => config.getWorkingDirectory?.() ?? undefined).heal(path, content, errors), signal);
      // Once, before the caller publishes: the caller re-checks the invocation, not the acceptance reading.
      check();
      return { ...result, assertCurrent: async () => { check(); }, assertCurrentSynchronous: check };
    } finally { stopWatching(); }
  }
  if (!config.get('tools.autoHeal')) return { healed: false, content, assertCurrent: async () => {}, assertCurrentSynchronous: () => {} };
  const binding = backend && backends.get(backend);
  if (!binding) throw new Error('Captured auto-heal requires its construction-owned backend');
  const context = capturedToolPublicationContext();
  const operation = new AbortController();
  const signal = AbortSignal.any([operation.signal, ...[binding.signal, context.signal, invocationSignal].filter((value): value is AbortSignal => value !== undefined)]);
  const target = resolve(path);
  await executePolicyCheck(() => assertCapturedToolReadAccess(target), signal);
  assertCapturedPublicationOwner(context.lease, binding.authority);
  const revision = captureCapturedToolWriteRevision(target, Buffer.from(content, 'utf8'));
  const checkSynchronous = (): void => {
    assertInvocation?.();
    signal.throwIfAborted();
    assertCapturedToolMutationCurrent(target);
    assertCapturedWriteRevision(revision, binding.authority, context.lease, target);
  };
  const check = async (): Promise<void> => {
    await executePolicyCheck(() => assertContractInputAuthority(binding.authority, binding.root, signal), signal);
    await executePolicyCheck(() => assertCapturedToolAccessCurrent(), signal);
    await executePolicyCheck(() => assertCapturedToolReadAccess(target), signal);
    checkSynchronous();
  };
  const reading = !isClassicOperation() && assertInvocation ? captureJudgmentPort('tools.auto-heal.acceptance', { signal, assertCurrent: checkSynchronous }) : undefined;
  await check();
  const transform = async (stage: 'formatter' | 'linter', file: string, candidate: string, warnings: string[]): Promise<string> => {
    await check();
    if (!binding.dependencyInputs?.length && !existsSync(join(binding.root, 'node_modules'))) {
      warnings.push(`Captured auto-heal ${stage} unavailable: no admitted project-local tool dependencies.`);
      return candidate;
    }
    const fileArg = quote(relative(binding.root, file));
    // Exact project-local binaries only. No PATH discovery, npm resolution,
    // project configuration, network, or publication of the command's writes.
    // For the same reason a formatter or linter from the user languages files
    // is not run here; the uncontained path above runs it.
    const command = stage === 'formatter'
      ? `if [ -x ./node_modules/.bin/prettier ]; then ./node_modules/.bin/prettier --no-config --no-editorconfig --ignore-path /dev/null --write --log-level silent -- ${fileArg}; else exit 127; fi`
      : `if [ -x ./node_modules/.bin/eslint ]; then ./node_modules/.bin/eslint --no-config-lookup --no-ignore --no-cache --fix --rule 'no-extra-semi:error' -- ${fileArg}; else exit 127; fi`;
    let transformed: string | undefined;
    const result = await runCapturedCommand(binding, command, {}, binding.root, 30_000, signal, 'disabled', {}, {
      publicationLease: context.lease, beforeSpawn: checkSynchronous,
      repairCandidate: { path: target, content: candidate, receive: (value) => { transformed = value; } },
    });
    await check();
    if (result.cancelled) throw new Error('Captured repair execution held');
    if (result.denied || result.timed_out || (stage === 'formatter' ? !result.success : result.exit_code !== 0 && result.exit_code !== 1) || transformed === undefined) {
      warnings.push(`Captured auto-heal ${stage} unavailable or unsuccessful: requires an admitted project-local binary supporting fixed config-free repair; ambient tools and project configuration are not used.`);
      return candidate;
    }
    return transformed;
  };
  // Providers and formatters can await or retry internally: the owned signal
  // stops them when the invocation is cancelled, the contract's input authority
  // is revoked, or the settings that admitted the write change. The healer checks between its stages; the caller
  // runs `assertCurrent` once more immediately before it publishes a repair.
  const stopWatching = abortOnSettingsChange(config, operation);
  let watchingContract = true;
  const stopWatchingContract = registerContractInputCleanup(binding.authority, () => {
    if (watchingContract && !operation.signal.aborted) operation.abort(new Error('captured input authority is missing or revoked'));
  });
  try {
    const result = await new AutoHealer(config, llm, { check, checkSynchronous, transform, signal }, assertInvocation, signal, reading).heal(target, content, errors);
    return { ...result, assertCurrent: check, assertCurrentSynchronous: checkSynchronous };
  } finally {
    stopWatching();
    // Disposal runs the cleanup once; the heal is over, so it must not abort the caller's final check.
    watchingContract = false;
    stopWatchingContract();
  }
}

import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync, statSync } from 'node:fs';
import type { HookDefinition, HookResult, HookEvent } from '../types.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { createHookExecution, hookTimeoutSeconds, type HookExecutionOptions } from '../execution.js';

/** Expected shape of a TypeScript hook module's default export */
type TsHookHandler = (event: HookEvent, execution?: HookExecutionOptions) => Promise<HookResult | void | undefined> | HookResult | void | undefined;

/**
 * TypeScript hook runner.
 * Dynamically imports the module at hook.path and calls its default export with the event.
 */
export async function run(hook: HookDefinition, event: HookEvent, projectRoot: string, options?: HookExecutionOptions): Promise<HookResult> {
  const path = hook.path;
  if (!path) {
    return { ok: false, error: 'ts hook missing "path" field' };
  }

  // The module must live inside the project directory. Compared on real paths,
  // so a symlink inside the project that points outside it is refused too.
  let resolvedPath: string;
  let realRoot: string;
  try {
    resolvedPath = realpathSync(resolve(projectRoot, path));
    realRoot = realpathSync(projectRoot);
  } catch {
    return { ok: false, error: `ts hook path '${path}' does not exist` };
  }
  const fromRoot = relative(realRoot, resolvedPath);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    return { ok: false, error: `ts hook path '${path}' is outside the project directory` };
  }

  // The deadline applies to an unowned run too; the handler is asked to stop through its signal.
  const execution = createHookExecution(options ?? {}, hookTimeoutSeconds(hook, 'ts'), 'ts');
  try {
    execution.signal.throwIfAborted();
    let moduleUrl = pathToFileURL(resolvedPath).href;
    try {
      const { mtimeMs } = statSync(resolvedPath);
      moduleUrl += `?mtime=${mtimeMs}`;
    } catch {
      // Ignore stat failures and fall back to the bare file URL so import can surface the real error.
    }

    const mod = await import(moduleUrl);
    execution.signal.throwIfAborted();
    const handler = mod.default as TsHookHandler | undefined;

    if (typeof handler !== 'function') {
      return { ok: false, error: `ts hook at ${path} does not export a default function` };
    }

    // In-process handlers cannot be forcibly stopped. Keep the invocation
    // owned until its actual settlement, even if it ignores the signal.
    const result: unknown = await handler(event, { signal: execution.signal });
    execution.signal.throwIfAborted();
    // A handler with no return value, or a bare decision, is a normal outcome:
    // read it the way the other runners read their output.
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return { ok: true };
    const handled = result as HookResult;
    return { ...handled, ok: handled.ok ?? true };
  } catch (err) {
    const message = summarizeError(err);
    logger.error('ts hook error', { path, error: message });
    return { ok: false, error: message };
  } finally {
    execution.dispose();
  }
}

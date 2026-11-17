import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readFileObservation } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ShellPathService } from '@/runtime/index.ts';
import type { MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import { MemorySpineClient, type MemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { assertCurrentToolEffect, assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector, type ToolExecuteOptions } from '@goodvibes-jev/engine/platform/platform/tools';
import { noteStorePath } from '../agent/note-registry.ts';
import { personaStorePath } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { routineStorePath } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { skillStorePath } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { assertAgentMemoryInput } from './agent-memory-input-guard.ts';
import { captureAgentExportPath } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

const contexts = new WeakMap<object, { readonly assertBeforeWrite: () => void; readonly assertLocation: () => void; readonly acceptOwnEffect: () => void }>();
const readActions = new Set(['list', 'search', 'get']);

function fileRevision(path: string) {
  try { return readFileObservation(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw new ToolInputProjectionError('held');
  }
}

/** Full local record input and physical source are captured before repair or admission. */
export function createAgentLocalRegistryInputProjector(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, memorySpine: MemoryAccess): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    const domain = request.args.domain, action = request.args.action;
    const reads = typeof action === 'string' && readActions.has(action);
    assertAgentMemoryInput(request.args, { screenSecrets: !reads });
    const home = shellPaths.homeDirectory, resolveUserPath = shellPaths.resolveUserPath;
    const memoryStore = memoryRegistry.getStore();
    const memoryScope = memorySpine instanceof MemorySpineClient ? memorySpine.captureOperationScope() : undefined;
    const path = domain === 'note' ? noteStorePath(shellPaths) : domain === 'persona' ? personaStorePath(shellPaths)
      : domain === 'routine' ? routineStorePath(shellPaths) : domain === 'skill' || domain === 'skill_bundle' ? skillStorePath(shellPaths)
      : domain === 'memory' ? memoryStore.dbPath : undefined;
    if (path === undefined) throw new ToolInputProjectionError('held');
    const physicalRoot = captureAgentExportPath(home, home);
    // The memory database is replaced atomically by its own commit, so its file identity changes with every
    // write; the directory chain above it stays pinned, and `before` still guards the file's content.
    let physical = path === null ? undefined : captureAgentExportPath(home, domain === 'memory' ? dirname(path) : path);
    let before = path === null ? null : fileRevision(path);
    const assertOwner = () => {
      if (shellPaths.homeDirectory !== home || shellPaths.resolveUserPath !== resolveUserPath
        || memoryRegistry.getStore() !== memoryStore) throw new ToolInputProjectionError('stale');
      memoryScope?.();
      physicalRoot.assertCurrent();
    };
    const assertLocation = () => {
      assertOwner();
      physical?.assertCurrent();
    };
    const assertTarget = () => {
      assertLocation();
      if (path !== null && !isDeepStrictEqual(fileRevision(path), before)) throw new ToolInputProjectionError('stale');
    };
    assertTarget();
    const context = Object.freeze({}); let released = false;
    const assertCurrent = () => { if (released) throw new ToolInputProjectionError('stale'); request.assertCurrent(); assertTarget(); };
    contexts.set(context, { assertBeforeWrite: assertTarget, assertLocation, acceptOwnEffect() {
      assertOwner();
      if (path !== null) { physical = captureAgentExportPath(home, domain === 'memory' ? dirname(path) : path); before = fileRevision(path); }
    } });
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
      ...(reads ? { resultPublication: 'read-only' } : {}),
      assertRepairedArgs(args) {
        assertAgentMemoryInput(args, { screenSecrets: !reads });
        if (args.domain !== domain || args.action !== action) throw new ToolInputProjectionError('binding-changed');
        assertCurrent();
      },
      async release() { released = true; contexts.delete(context); },
    };
  } };
}

/** Native atomic writer callbacks recognize only this invocation's own completed effect. */
export function createAgentLocalRegistryWriteLifecycle(args: Record<string, unknown>, options?: ToolExecuteOptions): {
  readonly assertCurrent: () => void; readonly onEffect: () => void;
} {
  return {
    assertCurrent() { assertAgentLocalRegistryWrite(args, options); },
    onEffect() {
      options?.signal?.throwIfAborted();
      if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
      const context = options?.inputProjectionContext, binding = context && contexts.get(context);
      if (!context || !binding) throw new ToolInputProjectionError('held');
      assertProjectionExecution(context, args); binding.acceptOwnEffect();
    },
  };
}

/** The actual registry-issued context is required at each local durable boundary. */
export function assertAgentLocalRegistryWrite(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  options?.signal?.throwIfAborted();
  if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
  const context = options?.inputProjectionContext;
  const binding = context && contexts.get(context);
  if (!context || !binding) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertBeforeWrite();
}

/** After this operation's own commit, location and authority remain live without undoing it. */
export function assertAgentLocalRegistryEffectCurrent(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  options?.signal?.throwIfAborted();
  if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
  const context = options?.inputProjectionContext, binding = context && contexts.get(context);
  if (!context || !binding) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertLocation();
}

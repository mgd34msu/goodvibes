import { assertCurrentToolEffect, ToolInputProjectionError, type ToolExecuteOptions, type ToolInputProjector } from '@goodvibes/engine/platform/platform/tools';

/**
 * Tells the gate that `list` only reads the register. Every other action is a
 * write and is admitted as one. The register's own guarantee (one read-modify-
 * write under its process lock, then an atomic rename) is what keeps the file
 * whole; nothing here re-proves it.
 */
export function createAgentAccountsInputProjector(): ToolInputProjector {
  return { async project(request) {
    request.signal?.throwIfAborted();
    return { status: 'projected', args: request.args, ...(request.args.action === 'list' ? { resultPublication: 'read-only' } : {}) };
  } };
}

/**
 * The write admission for one call: the gate admitted this exact invocation as
 * a write and the call is still wanted. Checked by the register immediately
 * before it writes; a direct `execute` that never passed the gate is held.
 */
export function agentAccountsWriteGuard(args: Record<string, unknown>, options?: ToolExecuteOptions): { readonly assertCurrent: () => void } {
  return { assertCurrent() {
    options?.signal?.throwIfAborted();
    if (!assertCurrentToolEffect(args, options, 'write')) {
      throw new ToolInputProjectionError('held', 'The accounts register is changed only by a call the host admitted as a write. Nothing was written.');
    }
  } };
}

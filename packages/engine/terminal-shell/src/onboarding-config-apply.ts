import type { RollbackAction } from './onboarding-file-helpers.js';

export interface OnboardingConfigOperation {
  readonly kind: 'set-config';
  readonly scope?: string | undefined;
  readonly key: string;
  readonly value: unknown;
}
/** Config mutation and rollback share the exact translated key set and product-owned file root. */
export function createOnboardingConfigApply<Dependencies, Operation extends OnboardingConfigOperation>(ports: {
  readonly validate: (operation: Operation) => void;
  readonly projectPath: (deps: Dependencies) => string;
  readonly readJsonObject: (path: string) => Record<string, unknown>;
  readonly writeJsonObject: (path: string, value: Record<string, unknown>) => void;
  readonly setNestedValue: (root: Record<string, unknown>, key: string, value: unknown) => Record<string, unknown>;
  readonly reload: (deps: Dependencies) => void;
  readonly get: (deps: Dependencies, key: string) => unknown;
  readonly set: (deps: Dependencies, key: string, value: unknown) => void;
  readonly snapshotFileRollback: (path: string, reload: () => void) => RollbackAction;
  readonly translate?: ((operation: Operation) => readonly { readonly key: string; readonly value: unknown }[] | undefined) | undefined;
}) {
  function captureWrites(operation: Operation) {
    const translated = ports.translate?.(operation);
    const writes = translated ?? [{ key: operation.key, value: operation.value }];
    const label = translated ? `${writes.map((write) => write.key).join(', ')} (legacy ${operation.key})` : operation.key;
    return { writes, label };
  }
  function validateConfigOperation(deps: Dependencies, operation: Operation): void {
    ports.validate(operation);
    if ((operation.scope ?? 'global') === 'project') ports.readJsonObject(ports.projectPath(deps));
  }
  function applyConfigOperation(deps: Dependencies, operation: Operation): { kind: 'set-config'; summary: string } {
    ports.validate(operation);
    const project = (operation.scope ?? 'global') === 'project';
    // Preserve file validation before product-specific translation.
    const path = project ? ports.projectPath(deps) : undefined;
    const existing = path === undefined ? undefined : ports.readJsonObject(path);
    const { writes, label } = captureWrites(operation);
    if (path !== undefined && existing !== undefined) {
      let updated = existing;
      for (const write of writes) updated = ports.setNestedValue(updated, write.key, write.value);
      ports.writeJsonObject(path, updated);
      ports.reload(deps);
    } else {
      for (const write of writes) ports.set(deps, write.key, write.value);
    }
    return {
      kind: operation.kind,
      summary: `${project ? 'Persisted' : 'Updated'} ${label} in ${project ? 'project' : 'global'} onboarding settings.`,
    };
  }
  function buildConfigRollbackAction(deps: Dependencies, operation: Operation): RollbackAction {
    if ((operation.scope ?? 'global') === 'project') return ports.snapshotFileRollback(ports.projectPath(deps), () => ports.reload(deps));
    const previous = captureWrites(operation).writes.map((write) => ({ key: write.key, value: ports.get(deps, write.key) }));
    return () => {
      for (const entry of previous) ports.set(deps, entry.key, entry.value);
    };
  }
  return { validateConfigOperation, applyConfigOperation, buildConfigRollbackAction };
}

import { existsSync, readFileSync } from 'node:fs';
import {
  isMalformedGoodVibesSecretReferenceValue,
  type LiteralSecretsManager,
  type SecretScope,
} from '@goodvibes-jev/engine/sdk/platform/config';
import type { createOnboardingStateStorage } from './onboarding-state.js';
import type {
  OnboardingAcknowledgementTarget,
  OnboardingShellPaths,
  OnboardingStateScope,
  OnboardingMode,
} from './onboarding-state-types.js';
import type { RollbackAction } from './onboarding-file-helpers.js';
import type { OnboardingVerificationResult } from './onboarding-verification.js';
export interface OnboardingApplyPrimitiveDependencies {
  readonly clock?: (() => number) | undefined;
  readonly secrets?: Pick<LiteralSecretsManager, 'set' | 'get' | 'delete' | 'inspect'> | undefined;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope | undefined;
}
export interface OnboardingSecretOperation {
  readonly kind: 'set-secret';
  readonly key: string;
  readonly value: string;
  readonly scope?: SecretScope | undefined;
  readonly medium: 'secure' | 'plaintext';
}
export interface OnboardingAcknowledgementOperation {
  readonly kind: 'acknowledge';
  readonly target: OnboardingAcknowledgementTarget;
  readonly acknowledged: boolean;
}
export function getNow(deps: { readonly clock?: (() => number) | undefined }): number {
  return deps.clock?.() ?? Date.now();
}
export function createOnboardingApplyPrimitives(
  storage: Pick<ReturnType<typeof createOnboardingStateStorage>, 'readOnboardingRuntimeState' | 'writeOnboardingAcknowledgementState'>,
  restoreFile: (path: string, previous: string | null) => void,
) {
  function validateSecretOperation(deps: OnboardingApplyPrimitiveDependencies, operation: OnboardingSecretOperation): void {
    if (!deps.secrets) throw new Error('Secret persistence is unavailable.');
    if (operation.key.trim().length === 0) throw new Error('Secret key is required.');
    if (operation.value.length === 0) throw new Error(`Secret value for ${operation.key} is required.`);
    if (!operation.medium) throw new Error(`Secret storage medium for ${operation.key} is required.`);
    if (isMalformedGoodVibesSecretReferenceValue(operation.value)) {
      throw new Error(`Secret value for ${operation.key} only accepts goodvibes://secrets/... secret references.`);
    }
  }
  function validateAcknowledgementOperation(
    deps: OnboardingApplyPrimitiveDependencies,
    operation: OnboardingAcknowledgementOperation,
  ): void {
    if (typeof operation.acknowledged !== 'boolean') {
      throw new Error(`${operation.target} acknowledgement must be boolean.`);
    }
    const state = storage.readOnboardingRuntimeState(deps.shellPaths, deps.acknowledgementScope ?? 'project');
    if (state.parseError) {
      throw new Error(`Existing onboarding acknowledgement state could not be parsed: ${state.parseError}`);
    }
  }
  async function applySecretOperation(
    deps: OnboardingApplyPrimitiveDependencies,
    operation: OnboardingSecretOperation,
  ): Promise<{
    readonly kind: 'set-secret' | 'acknowledge';
    readonly summary: string;
  }> {
    validateSecretOperation(deps, operation);
    await deps.secrets!.set(operation.key, operation.value, {
      scope: operation.scope ?? 'project',
      ...(operation.medium ? { medium: operation.medium } : {}),
    });
    return {
      kind: operation.kind,
      summary: `Stored ${operation.key} through the configured secret manager.`,
    };
  }
  async function buildSecretRollbackAction(
    deps: OnboardingApplyPrimitiveDependencies,
    operation: OnboardingSecretOperation,
  ): Promise<RollbackAction> {
    validateSecretOperation(deps, operation);
    const scope = operation.scope ?? 'project';
    const review = await deps.secrets!.inspect();
    const locations = review.locations.filter((entry) => entry.source.startsWith(`${scope}-`));
    if (locations.length === 0) throw new Error(`Secret storage locations for ${scope} scope are unavailable.`);
    const snapshots = locations.map((location) => ({
      path: location.path,
      previous: existsSync(location.path) ? readFileSync(location.path, 'utf-8') : null,
    }));
    return () => {
      for (const snapshot of snapshots) restoreFile(snapshot.path, snapshot.previous);
    };
  }
  function applyAcknowledgementOperation(
    deps: OnboardingApplyPrimitiveDependencies,
    request: {
      readonly mode: OnboardingMode;
      readonly source: string;
    },
    operation: OnboardingAcknowledgementOperation,
  ): {
    readonly kind: 'set-secret' | 'acknowledge';
    readonly summary: string;
  } {
    storage.writeOnboardingAcknowledgementState(deps.shellPaths, {
      scope: deps.acknowledgementScope ?? 'project',
      target: operation.target,
      acknowledged: operation.acknowledged,
      updatedAt: getNow(deps),
      source: request.source,
      mode: request.mode,
    });
    return {
      kind: operation.kind,
      summary: `${operation.target} acknowledgement set to ${operation.acknowledged ? 'accepted' : 'pending'}.`,
    };
  }
  return {
    validateSecretOperation,
    applySecretOperation,
    buildSecretRollbackAction,
    validateAcknowledgementOperation,
    applyAcknowledgementOperation,
  };
}
/** A failed readback rolls back every admitted mutation and reports every verification failure. */
export async function verifyOnboardingWithRollback<Kind extends string>(
  verify: () => Promise<OnboardingVerificationResult>,
  rollback: () => Promise<readonly string[]>,
  applied: {
    length: number;
  },
  errors: {
    push(
      ...items: {
        readonly kind: Kind;
        readonly message: string;
      }[]
    ): unknown;
  },
  kindFor: (id: string) => Kind,
): Promise<boolean> {
  const verification = await verify();
  const failures = verification.items.filter((item) => item.status !== 'pass');
  if (failures.length === 0) return true;
  const rollbackErrors = await rollback();
  applied.length = 0;
  errors.push(
    ...failures.map((item, index) => ({
      kind: kindFor(item.id),
      message: [`verify ${item.id}: ${item.message}`, ...(index === 0 ? rollbackErrors.map((error) => `rollback: ${error}`) : [])].join(
        '; ',
      ),
    })),
  );
  return false;
}

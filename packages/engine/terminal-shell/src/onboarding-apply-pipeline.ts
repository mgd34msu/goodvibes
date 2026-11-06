import { verifyOnboardingWithRollback } from './onboarding-apply-primitives.js';
import type { RollbackAction } from './onboarding-file-helpers.js';
import type { OnboardingVerificationResult } from './onboarding-verification.js';
export function orderOnboardingOperations<Operation extends { readonly kind: string; readonly key?: string | undefined }>(
  operations: readonly Operation[],
  extraGroups: readonly (readonly string[])[] = [],
): readonly Operation[] {
  return [
    ...operations.filter((operation) => operation.kind === 'set-config' && operation.key === 'storage.secretPolicy'),
    ...operations.filter((operation) => operation.kind === 'ensure-auth-user'),
    ...operations.filter((operation) => operation.kind === 'set-secret'),
    ...operations.filter((operation) => operation.kind === 'set-config' && operation.key !== 'storage.secretPolicy'),
    ...extraGroups.flatMap((kinds) => operations.filter((operation) => kinds.includes(operation.kind))),
    ...operations.filter((operation) => operation.kind === 'acknowledge'),
  ];
}
/** Shared transactional apply/verify/rollback lifetime, parameterized by product operation authority. */
export function createOnboardingApplyPipeline<
  Dependencies,
  Operation extends { readonly kind: string },
  Request extends { readonly operations: readonly Operation[] },
  Applied extends { readonly kind: Operation['kind']; readonly summary: string },
>(ports: {
  readonly prevalidate: (deps: Dependencies, request: Request) => { kind: Operation['kind']; message: string }[];
  readonly order: (operations: readonly Operation[]) => readonly Operation[];
  readonly rollbackFor: (deps: Dependencies, operation: Operation) => Promise<RollbackAction>;
  readonly apply: (deps: Dependencies, request: Request, operation: Operation) => Applied | Promise<Applied> | null;
  readonly rollback: (actions: readonly RollbackAction[]) => Promise<readonly string[]>;
  readonly verify: (deps: Dependencies, request: Request) => Promise<OnboardingVerificationResult>;
  readonly verificationFailureKind: (id: string) => Operation['kind'];
  readonly describeError: (error: unknown) => string;
}) {
  async function applyOnboardingRequest(deps: Dependencies, request: Request) {
    const applied: Applied[] = [],
      skipped: never[] = [];
    const errors = ports.prevalidate(deps, request);
    if (errors.length) return { ok: false, applied, skipped, errors };
    const operations = ports.order(request.operations);
    const rollbacks: RollbackAction[] = [];
    for (const operation of operations) {
      let rollback: RollbackAction = () => {};
      try {
        rollback = await ports.rollbackFor(deps, operation);
        const result = ports.apply(deps, request, operation);
        // Synchronous writes keep their original no-yield path between effect and rollback registration.
        const value = result instanceof Promise ? await result : result;
        if (value !== null) {
          applied.push(value);
          rollbacks.push(rollback);
        }
      } catch (error) {
        const failures = await ports.rollback([...rollbacks, rollback]);
        applied.length = 0;
        errors.push({
          kind: operation.kind,
          message: [ports.describeError(error), ...failures.map((failure) => 'rollback: ' + failure)].join('; '),
        });
        return { ok: false, applied, skipped, errors };
      }
    }
    const okay = await verifyOnboardingWithRollback(
      () => ports.verify(deps, { ...request, operations }),
      () => ports.rollback(rollbacks),
      applied,
      errors,
      ports.verificationFailureKind,
    );
    return { ok: okay && errors.length === 0, applied, skipped, errors };
  }
  return { applyOnboardingRequest };
}

/** Validate all operations before any effects, preserving product dispatch and error vocabulary. */
export function prevalidateOnboardingOperations<Operation extends { readonly kind: string }>(
  operations: readonly Operation[],
  validate: (operation: Operation, ordered: readonly Operation[]) => void,
  describeError: (error: unknown) => string,
): { kind: Operation['kind']; message: string }[] {
  const errors: { kind: Operation['kind']; message: string }[] = [];
  for (const operation of operations) {
    try {
      validate(operation, operations);
    } catch (error) {
      errors.push({ kind: operation.kind, message: describeError(error) });
    }
  }
  return errors;
}

export function onboardingVerificationFailureKind(itemId: string): 'set-config' | 'set-secret' | 'ensure-auth-user' | 'acknowledge' {
  if (itemId.startsWith('secret:')) return 'set-secret';
  if (itemId.startsWith('auth:')) return 'ensure-auth-user';
  if (itemId.startsWith('acknowledge:')) return 'acknowledge';
  return 'set-config';
}

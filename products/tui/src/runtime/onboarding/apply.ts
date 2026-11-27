import { isDaemonOwnedConfigKey, projectSettingsFileOf } from '@goodvibes/engine/platform/platform/config';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { createOnboardingConfigApply } from '@goodvibes/engine/terminal-shell/onboarding-config-apply';
import {
  createOnboardingApplyPipeline,
  onboardingVerificationFailureKind,
  orderOnboardingOperations,
  prevalidateOnboardingOperations,
} from '@goodvibes/engine/terminal-shell/onboarding-apply-pipeline';
import { createOnboardingConfigValidator } from '@goodvibes/engine/terminal-shell/onboarding-config-validation';
const { validateConfigValue } = createOnboardingConfigValidator<Extract<OnboardingApplyOperation, { kind: 'set-config' }>>({
  separator: ': ',
});
import { createOnboardingApplyPrimitives } from '@goodvibes/engine/terminal-shell/onboarding-apply-primitives';
import { createOnboardingFileHelpers, type RollbackAction } from '@goodvibes/engine/terminal-shell/onboarding-file-helpers';
const { readJsonObject, writeJsonObject, setNestedValue, snapshotFileRollback, runRollbacks } =
  createOnboardingFileHelpers();
import { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState } from './state.ts';
import { verifyOnboardingRequest } from './verify.ts';
import type {
  OnboardingApplyDependencies,
  OnboardingAppliedOperation,
  OnboardingApplyError,
  OnboardingApplyOperation,
  OnboardingApplyRequest,
} from './types.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';

const { applyConfigOperation, buildConfigRollbackAction, validateConfigOperation } = createOnboardingConfigApply<
  OnboardingApplyDependencies,
  Extract<OnboardingApplyOperation, { kind: 'set-config' }>
>({
  validate: validateConfigValue,
  // The project's one settings file every program reads (config/project-settings-file.ts).
  projectPath: (deps) => projectSettingsFileOf(deps.shellPaths.workingDirectory),
  readJsonObject,
  writeJsonObject,
  setNestedValue,
  snapshotFileRollback,
  reload: (deps) => deps.config.load(),
  get: (deps, key) => deps.config.get(key as never),
  // Applied from the wizard the person completed with their own press: it goes with every write.
  set: (deps, key, value) => deps.config.setDynamic(key as never, value, { press: { personAsked: true } }),
  isUnset: (deps, key) => deps.config.describeConfigKeySource(key as never).effectiveOrigin === 'default',
  unset: (deps, key) => deps.config.reset(key as never, { press: { personAsked: true } }),
});

/**
 * A setting the daemon owns goes to it and counts as applied only once it
 * took it: a refusal fails this step, so the whole apply is rolled back and
 * reported instead of "applied". Nothing is awaited when nothing was sent.
 */
async function applyConfigAndConfirm(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>,
): Promise<OnboardingAppliedOperation> {
  const finish = deps.config.watchDaemonWrites?.();
  const applied = applyConfigOperation(deps, operation);
  const refused = finish ? await finish() : [];
  if (refused.length > 0) {
    throw new Error(refused.map((entry) => `the daemon refused ${entry.key} (${summarizeError(entry.error)})`).join('; '));
  }
  return applied;
}

async function buildRollbackAction(deps: OnboardingApplyDependencies, operation: OnboardingApplyOperation): Promise<RollbackAction> {
  if (operation.kind === 'set-config') return buildConfigRollbackAction(deps, operation);

  if (operation.kind === 'set-secret') {
    return buildSecretRollbackAction(deps, operation);
  }

  if (operation.kind === 'acknowledge') {
    return snapshotFileRollback(getOnboardingRuntimeStatePath(deps.shellPaths, deps.acknowledgementScope ?? 'project'));
  }

  const neverOperation: never = operation;
  throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
}

/** A write of one of the daemon's own settings (not into the project's file): sent with the others as one update. */
function daemonSettingWrite(operation: OnboardingApplyOperation): operation is Extract<OnboardingApplyOperation, { kind: 'set-config' }> {
  return operation.kind === 'set-config' && (operation.scope ?? 'global') !== 'project' && isDaemonOwnedConfigKey(operation.key);
}

/** Every operation in order, the daemon's own settings left out: those are the last act, as one update (commitDaemonSettings). */
const orderApplyOperations = (operations: readonly OnboardingApplyOperation[]): readonly OnboardingApplyOperation[] =>
  orderOnboardingOperations(operations.filter((operation) => !daemonSettingWrite(operation)));

/**
 * The daemon's own settings of the form, sent last as ONE update the daemon admits whole before it writes any
 * (config.setMany): refused, nothing of it changed and the rest of the apply is rolled back here (nothing of it went
 * to the daemon but secrets, undone over a connection that has not moved); taken, it is answered before the daemon
 * moves a listener it rebinds for it, and nothing after it needs undoing.
 */
async function commitDaemonSettings(deps: OnboardingApplyDependencies, request: OnboardingApplyRequest): Promise<readonly OnboardingAppliedOperation[]> {
  // One write per setting: a later write of the same key in the form (a feature's switch that is also the app's) wins.
  const last = new Map<string, unknown>();
  for (const operation of request.operations.filter(daemonSettingWrite)) last.set(operation.key, operation.value);
  const writes = [...last].map(([key, value]) => ({ key, value }));
  if (writes.length === 0) return [];
  const result = deps.config.setMany(writes.map(({ key, value }) => ({ key: key as never, value })), localOwnerActor(), { press: { personAsked: true } });
  if (!result.ok) throw new Error(result.refusal.reason);
  const refused = result.pending ? await result.pending.settle() : [];
  if (refused.length > 0) {
    throw new Error(refused.map((entry) => `the daemon refused ${entry.key} (${summarizeError(entry.error)})`).join('; '));
  }
  return [{ kind: 'set-config', summary: `Updated ${writes.map((write) => write.key).join(', ')} in the daemon's settings, as one update.` }];
}

function prevalidateApplyRequest(deps: OnboardingApplyDependencies, request: OnboardingApplyRequest): OnboardingApplyError[] {
  return prevalidateOnboardingOperations(
    // Every operation, the daemon's settings included: nothing is applied when one of them is not valid.
    orderOnboardingOperations(request.operations),
    (operation) => {
      if (operation.kind === 'set-config') {
        validateConfigOperation(deps, operation);
        return;
      }

      if (operation.kind === 'set-secret') {
        validateSecretOperation(deps, operation);
        return;
      }

      if (operation.kind === 'acknowledge') {
        validateAcknowledgementOperation(deps, operation);
        return;
      }

      const neverOperation: never = operation;
      throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
    },
    summarizeError,
  );
}

const getVerificationFailureKind = onboardingVerificationFailureKind;

export const { applyOnboardingRequest } = createOnboardingApplyPipeline<
  OnboardingApplyDependencies,
  OnboardingApplyOperation,
  OnboardingApplyRequest,
  OnboardingAppliedOperation
>({
  prevalidate: prevalidateApplyRequest,
  order: orderApplyOperations,
  rollbackFor: buildRollbackAction,
  rollback: runRollbacks,
  verify: verifyOnboardingRequest,
  verificationFailureKind: getVerificationFailureKind,
  describeError: summarizeError,
  commit: commitDaemonSettings,
  apply(deps, request, operation) {
    if (operation.kind === 'set-config') return applyConfigAndConfirm(deps, operation);
    if (operation.kind === 'set-secret') return applySecretOperation(deps, operation);
    if (operation.kind === 'acknowledge') return applyAcknowledgementOperation(deps, request, operation);
    const neverOperation: never = operation;
    throw new Error('Unsupported onboarding operation: ' + JSON.stringify(neverOperation));
  },
});

const {
  validateSecretOperation,
  applySecretOperation,
  buildSecretRollbackAction,
  validateAcknowledgementOperation,
  applyAcknowledgementOperation,
} = createOnboardingApplyPrimitives({ readOnboardingRuntimeState, writeOnboardingAcknowledgementState });

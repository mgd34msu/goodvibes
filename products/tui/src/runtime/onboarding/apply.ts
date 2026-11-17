import { createOnboardingConfigApply } from '@goodvibes-jev/engine/terminal-shell/onboarding-config-apply';
import {
  createOnboardingApplyPipeline,
  onboardingVerificationFailureKind,
  orderOnboardingOperations,
  prevalidateOnboardingOperations,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-apply-pipeline';
import { createOnboardingConfigValidator } from '@goodvibes-jev/engine/terminal-shell/onboarding-config-validation';
const { validateConfigValue } = createOnboardingConfigValidator<Extract<OnboardingApplyOperation, { kind: 'set-config' }>>({
  separator: ': ',
});
import { createOnboardingApplyPrimitives } from '@goodvibes-jev/engine/terminal-shell/onboarding-apply-primitives';
import { createOnboardingFileHelpers, type RollbackAction } from '@goodvibes-jev/engine/terminal-shell/onboarding-file-helpers';
const { readJsonObject, writeJsonObject, setNestedValue, restoreFile, snapshotFileRollback, runRollbacks } =
  createOnboardingFileHelpers();
import { existsSync, readFileSync } from 'node:fs';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';
import { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState } from './state.ts';
import { verifyOnboardingRequest } from './verify.ts';
import type {
  OnboardingApplyDependencies,
  OnboardingAppliedOperation,
  OnboardingApplyError,
  OnboardingApplyOperation,
  OnboardingApplyRequest,
} from './types.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

interface BootstrapCredential {
  readonly username: string;
  readonly password: string;
}

function parseBootstrapCredential(content: string | null): BootstrapCredential | null {
  if (content === null) return null;
  let username = '';
  let password = '';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('username=')) username = line.slice('username='.length);
    if (line.startsWith('password=')) password = line.slice('password='.length);
  }
  return username.length > 0 && password.length > 0 ? { username, password } : null;
}

function validateAuthOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): void {
  if (!deps.auth) throw new Error('Local auth management is unavailable.');
  if (operation.username.trim().length === 0) throw new Error('Local auth username is required.');
  if (operation.password.length === 0) throw new Error(`Local auth password for ${operation.username} is required.`);
  const username = operation.username.trim();
  const existing = deps.auth.inspect().users.find((user) => user.username === username);
  const requiredRoles = operation.roles ?? ['admin'];
  if (existing && !requiredRoles.every((role) => existing.roles.includes(role))) {
    throw new Error(`Existing local auth user ${username} is missing required role(s): ${requiredRoles.join(', ')}.`);
  }
}

const { applyConfigOperation, buildConfigRollbackAction, validateConfigOperation } = createOnboardingConfigApply<
  OnboardingApplyDependencies,
  Extract<OnboardingApplyOperation, { kind: 'set-config' }>
>({
  validate: validateConfigValue,
  projectPath: (deps) => deps.shellPaths.resolveProjectPath('tui', 'settings.json'),
  readJsonObject,
  writeJsonObject,
  setNestedValue,
  snapshotFileRollback,
  reload: (deps) => deps.config.load(),
  get: (deps, key) => deps.config.get(key as never),
  set: (deps, key, value) => deps.config.setDynamic(key as never, value),
  isUnset: (deps, key) => deps.config.describeConfigKeySource(key as never).effectiveOrigin === 'default',
  unset: (deps, key) => deps.config.reset(key as never),
});

function applyAuthOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): OnboardingAppliedOperation {
  validateAuthOperation(deps, operation);
  const auth = deps.auth!;
  const username = operation.username.trim();
  const before = auth.inspect();
  const existing = before.users.find((user) => user.username === username);
  const bootstrapCredential = before.bootstrapCredentialPresent
    ? parseBootstrapCredential(readFileSync(before.bootstrapCredentialPath, 'utf-8'))
    : null;

  if (existing) {
    auth.rotatePassword(username, operation.password);
  } else {
    auth.addUser(username, operation.password, operation.roles ?? ['admin']);
  }

  if (operation.retireBootstrapCredential) {
    if (bootstrapCredential && bootstrapCredential.username !== username && auth.getUser(bootstrapCredential.username)) {
      auth.deleteUser(bootstrapCredential.username);
    }
    auth.clearBootstrapCredentialFile();
  }

  if (operation.createSession ?? true) {
    auth.createSession(username);
  }

  return {
    kind: operation.kind,
    summary: existing ? `Updated local auth user ${username}.` : `Created local auth user ${username}.`,
  };
}

function buildAuthRollbackAction(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): RollbackAction {
  validateAuthOperation(deps, operation);
  const auth = deps.auth!;
  const before = auth.inspect();
  const state = auth.snapshotState();
  const userStoreSnapshot = existsSync(before.userStorePath) ? readFileSync(before.userStorePath, 'utf-8') : null;
  const bootstrapCredentialSnapshot = existsSync(before.bootstrapCredentialPath)
    ? readFileSync(before.bootstrapCredentialPath, 'utf-8')
    : null;

  return () => {
    restoreFile(before.bootstrapCredentialPath, bootstrapCredentialSnapshot);
    restoreFile(before.userStorePath, userStoreSnapshot);
    // The files are back; the live accounts and sessions return to exactly what they were, including
    // sessions this apply created and a bootstrap user it retired.
    auth.restoreState(state);
  };
}

async function buildRollbackAction(deps: OnboardingApplyDependencies, operation: OnboardingApplyOperation): Promise<RollbackAction> {
  if (operation.kind === 'set-config') return buildConfigRollbackAction(deps, operation);

  if (operation.kind === 'set-secret') {
    return buildSecretRollbackAction(deps, operation);
  }

  if (operation.kind === 'ensure-auth-user') {
    return buildAuthRollbackAction(deps, operation);
  }

  if (operation.kind === 'acknowledge') {
    return snapshotFileRollback(getOnboardingRuntimeStatePath(deps.shellPaths, deps.acknowledgementScope ?? 'project'));
  }

  const neverOperation: never = operation;
  throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
}

const orderApplyOperations = (operations: readonly OnboardingApplyOperation[]): readonly OnboardingApplyOperation[] =>
  orderOnboardingOperations(operations);

function prevalidateApplyRequest(deps: OnboardingApplyDependencies, request: OnboardingApplyRequest): OnboardingApplyError[] {
  return prevalidateOnboardingOperations(
    orderApplyOperations(request.operations),
    (operation) => {
      if (operation.kind === 'set-config') {
        validateConfigOperation(deps, operation);
        return;
      }

      if (operation.kind === 'set-secret') {
        validateSecretOperation(deps, operation);
        return;
      }

      if (operation.kind === 'ensure-auth-user') {
        validateAuthOperation(deps, operation);
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
  apply(deps, request, operation) {
    if (operation.kind === 'set-config') return applyConfigOperation(deps, operation);
    if (operation.kind === 'set-secret') return applySecretOperation(deps, operation);
    if (operation.kind === 'ensure-auth-user') return applyAuthOperation(deps, operation);
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

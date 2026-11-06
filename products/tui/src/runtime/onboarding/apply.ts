import { createOnboardingConfigValidator } from '@goodvibes-jev/engine/terminal-shell/onboarding-config-validation';
const { validateConfigValue } = createOnboardingConfigValidator<Extract<OnboardingApplyOperation, { kind: 'set-config' }>>({
  separator: ': ',
});
import {
  createOnboardingApplyPrimitives,
  verifyOnboardingWithRollback,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-apply-primitives';
import { createOnboardingFileHelpers, type RollbackAction } from '@goodvibes-jev/engine/terminal-shell/onboarding-file-helpers';
const { isPlainObject, readJsonObject, writeJsonObject, setNestedValue, restoreFile, snapshotFileRollback, runRollbacks } =
  createOnboardingFileHelpers();
import { existsSync, readFileSync } from 'node:fs';
import '@goodvibes-jev/engine/sdk/platform/config';
import '@goodvibes-jev/engine/sdk/platform/config';
import '@goodvibes-jev/engine/sdk/platform/config';
import { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState } from './state.ts';
import { verifyOnboardingRequest } from './verify.ts';
import type {
  OnboardingApplyDependencies,
  OnboardingAppliedOperation,
  OnboardingApplyError,
  OnboardingApplyOperation,
  OnboardingApplyRequest,
  OnboardingApplyResult,
} from './types.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

interface BootstrapCredential {
  readonly username: string;
  readonly password: string;
}

interface PersistedAuthUser {
  readonly username: string;
  readonly passwordHash: string;
  readonly roles?: readonly string[];
}

interface MutableAuthManager {
  readonly users?: Map<string, PersistedAuthUser>;
  readonly sessions?: Map<string, { readonly token: string; readonly username: string; readonly expiresAt: number }>;
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

function parsePersistedAuthUsers(content: string): readonly PersistedAuthUser[] {
  const parsed = JSON.parse(content) as unknown;
  if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.users)) {
    throw new Error('Expected a version 1 local auth user store.');
  }
  return parsed.users.filter(
    (user): user is PersistedAuthUser =>
      isPlainObject(user) &&
      typeof user.username === 'string' &&
      typeof user.passwordHash === 'string' &&
      (user.roles === undefined || (Array.isArray(user.roles) && user.roles.every((role) => typeof role === 'string'))),
  );
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

function applyConfigOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>,
): OnboardingAppliedOperation {
  validateConfigValue(operation);

  if ((operation.scope ?? 'global') === 'project') {
    const path = deps.shellPaths.resolveProjectPath('tui', 'settings.json');
    const existing = readJsonObject(path);
    const updated = setNestedValue(existing, operation.key, operation.value);
    writeJsonObject(path, updated);
    deps.config.load();

    return {
      kind: operation.kind,
      summary: `Persisted ${operation.key} in project onboarding settings.`,
    };
  }

  deps.config.setDynamic(operation.key as never, operation.value);
  return {
    kind: operation.kind,
    summary: `Updated ${operation.key} in global onboarding settings.`,
  };
}

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
  const mutable = auth as unknown as MutableAuthManager;
  const username = operation.username.trim();
  const before = auth.inspect();
  const existingUser = before.users.find((user) => user.username === username);
  const existingSessionFingerprints = new Set(
    before.sessions.filter((session) => session.username === username).map((session) => session.tokenFingerprint),
  );
  const userStoreSnapshot = existsSync(before.userStorePath) ? readFileSync(before.userStorePath, 'utf-8') : null;
  const bootstrapCredentialSnapshot = existsSync(before.bootstrapCredentialPath)
    ? readFileSync(before.bootstrapCredentialPath, 'utf-8')
    : null;
  const bootstrapCredential = parseBootstrapCredential(bootstrapCredentialSnapshot);
  const beforeSessions =
    mutable.sessions instanceof Map ? [...mutable.sessions.entries()].map(([token, session]) => [token, { ...session }] as const) : [];

  return () => {
    for (const session of auth.inspect().sessions) {
      if (session.username === username && !existingSessionFingerprints.has(session.tokenFingerprint)) {
        auth.revokeSession(session.tokenFingerprint);
      }
    }

    if (bootstrapCredential && !auth.getUser(bootstrapCredential.username)) {
      auth.addUser(bootstrapCredential.username, bootstrapCredential.password, ['admin']);
    }

    if (!existingUser && auth.getUser(username)) {
      try {
        auth.deleteUser(username);
      } catch (error) {
        if (mutable.users instanceof Map) mutable.users.delete(username);
        else throw error;
      }
    }

    restoreFile(before.bootstrapCredentialPath, bootstrapCredentialSnapshot);
    restoreFile(before.userStorePath, userStoreSnapshot);

    if (mutable.users instanceof Map) {
      if (userStoreSnapshot === null) {
        if (before.users.length === 0) mutable.users.clear();
      } else {
        mutable.users.clear();
        for (const user of parsePersistedAuthUsers(userStoreSnapshot)) mutable.users.set(user.username, user);
      }
    }

    if (mutable.sessions instanceof Map) {
      mutable.sessions.clear();
      for (const [token, session] of beforeSessions) mutable.sessions.set(token, session);
    }
  };
}

async function buildRollbackAction(deps: OnboardingApplyDependencies, operation: OnboardingApplyOperation): Promise<RollbackAction> {
  if (operation.kind === 'set-config') {
    if ((operation.scope ?? 'global') === 'project') {
      return snapshotFileRollback(deps.shellPaths.resolveProjectPath('tui', 'settings.json'), () => deps.config.load());
    }

    const previous = deps.config.get(operation.key as never);
    return () => {
      deps.config.setDynamic(operation.key as never, previous);
    };
  }

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

function orderApplyOperations(operations: readonly OnboardingApplyOperation[]): readonly OnboardingApplyOperation[] {
  const secretPolicyOperations = operations.filter(
    (operation) => operation.kind === 'set-config' && operation.key === 'storage.secretPolicy',
  );
  const authOperations = operations.filter((operation) => operation.kind === 'ensure-auth-user');
  const secretOperations = operations.filter((operation) => operation.kind === 'set-secret');
  const configOperations = operations.filter((operation) => operation.kind === 'set-config' && operation.key !== 'storage.secretPolicy');
  const finalOperations = operations.filter((operation) => operation.kind === 'acknowledge');

  return [...secretPolicyOperations, ...authOperations, ...secretOperations, ...configOperations, ...finalOperations];
}

function prevalidateApplyRequest(deps: OnboardingApplyDependencies, request: OnboardingApplyRequest): OnboardingApplyError[] {
  const errors: OnboardingApplyError[] = [];
  const orderedOperations = orderApplyOperations(request.operations);

  for (const operation of orderedOperations) {
    try {
      if (operation.kind === 'set-config') {
        validateConfigValue(operation);
        if ((operation.scope ?? 'global') === 'project') {
          readJsonObject(deps.shellPaths.resolveProjectPath('tui', 'settings.json'));
        }
        continue;
      }

      if (operation.kind === 'set-secret') {
        validateSecretOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'ensure-auth-user') {
        validateAuthOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'acknowledge') {
        validateAcknowledgementOperation(deps, operation);
        continue;
      }

      const neverOperation: never = operation;
      throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
    } catch (error) {
      errors.push({
        kind: operation.kind,
        message: summarizeError(error),
      });
    }
  }

  return errors;
}

function getVerificationFailureKind(itemId: string): OnboardingApplyOperation['kind'] {
  if (itemId.startsWith('config:')) return 'set-config';
  if (itemId.startsWith('secret:')) return 'set-secret';
  if (itemId.startsWith('auth:')) return 'ensure-auth-user';
  if (itemId.startsWith('acknowledge:')) return 'acknowledge';
  return 'set-config';
}

export async function applyOnboardingRequest(
  deps: OnboardingApplyDependencies,
  request: OnboardingApplyRequest,
): Promise<OnboardingApplyResult> {
  const applied: OnboardingAppliedOperation[] = [];
  const skipped: never[] = [];
  const errors: OnboardingApplyError[] = prevalidateApplyRequest(deps, request);
  if (errors.length > 0) {
    return {
      ok: false,
      applied,
      skipped,
      errors,
    };
  }

  const orderedOperations = orderApplyOperations(request.operations);
  const rollbacks: RollbackAction[] = [];

  const applyOperations = async (operations: readonly OnboardingApplyOperation[]): Promise<boolean> => {
    for (const operation of operations) {
      let rollback: RollbackAction = () => {};
      try {
        rollback = await buildRollbackAction(deps, operation);
        if (operation.kind === 'set-config') {
          applied.push(applyConfigOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'set-secret') {
          applied.push(await applySecretOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'ensure-auth-user') {
          applied.push(applyAuthOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'acknowledge') {
          applied.push(applyAcknowledgementOperation(deps, request, operation));
          rollbacks.push(rollback);
          continue;
        }

        const neverOperation: never = operation;
        throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
      } catch (error) {
        const rollbackErrors = await runRollbacks([...rollbacks, rollback]);
        applied.length = 0;
        errors.push({
          kind: operation.kind,
          message: [summarizeError(error), ...rollbackErrors.map((rollbackError) => `rollback: ${rollbackError}`)].join('; '),
        });
        return false;
      }
    }
    return true;
  };

  const verifyOrRollback = (operations: readonly OnboardingApplyOperation[]): Promise<boolean> =>
    verifyOnboardingWithRollback(
      () => verifyOnboardingRequest(deps, { ...request, operations }),
      () => runRollbacks(rollbacks),
      applied,
      errors,
      getVerificationFailureKind,
    );

  if (!(await applyOperations(orderedOperations))) {
    return { ok: false, applied, skipped, errors };
  }

  if (!(await verifyOrRollback(orderedOperations))) {
    return { ok: false, applied, skipped, errors };
  }

  return {
    ok: errors.length === 0,
    applied,
    skipped,
    errors,
  };
}

const {
  validateSecretOperation,
  applySecretOperation,
  buildSecretRollbackAction,
  validateAcknowledgementOperation,
  applyAcknowledgementOperation,
} = createOnboardingApplyPrimitives({ readOnboardingRuntimeState, writeOnboardingAcknowledgementState }, restoreFile);

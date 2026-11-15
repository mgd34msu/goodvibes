import { isGoodVibesSecretReferenceValue, type SecretScope } from '@goodvibes-jev/engine/platform/platform/config';
import type { UserAuthManager } from '@goodvibes-jev/engine/platform/platform/security';
import type { OnboardingAcknowledgementTarget, OnboardingShellPaths, OnboardingStateScope } from './onboarding-state-types.js';
import type { OnboardingRuntimeStateRecord } from './onboarding-state.js';
import { isDeepEqual } from './onboarding-values.js';
export type OnboardingVerificationStatus = 'pass' | 'warn' | 'fail';
export interface OnboardingVerificationItem {
  readonly id: string;
  readonly status: OnboardingVerificationStatus;
  readonly message: string;
  readonly target?: string | undefined;
}
export interface OnboardingVerificationResult {
  readonly verifiedAt: number;
  readonly ok: boolean;
  readonly items: readonly OnboardingVerificationItem[];
}
export type CommonOnboardingVerificationOperation<Key extends string> =
  | { readonly kind: 'set-config'; readonly key: Key; readonly value: unknown }
  | { readonly kind: 'set-secret'; readonly key: string; readonly value: string; readonly scope?: SecretScope | undefined }
  | { readonly kind: 'acknowledge'; readonly target: OnboardingAcknowledgementTarget; readonly acknowledged: boolean }
  | {
      readonly kind: 'ensure-auth-user';
      readonly username: string;
      readonly roles?: readonly string[] | undefined;
      readonly createSession?: boolean | undefined;
      readonly retireBootstrapCredential?: boolean | undefined;
    };
export interface OnboardingVerificationDependencies<Key extends string> {
  readonly clock?: (() => number) | undefined;
  readonly config: { get(key: Key): unknown };
  /**
   * `getFromScope` reads the scope the write went to; the live secrets manager
   * always has it (optional only so a narrower host type still passes).
   */
  readonly secrets?:
    | { get(key: string): Promise<string | null>; getFromScope?(key: string, scope: SecretScope): Promise<string | null> }
    | undefined;
  readonly auth?: Pick<UserAuthManager, 'inspect'> | undefined;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope | undefined;
}
export interface OnboardingVerificationPorts<
  Key extends string,
  Dependencies extends OnboardingVerificationDependencies<Key>,
  Operation,
  Extra,
> {
  readonly readState: (paths: OnboardingShellPaths, scope: OnboardingStateScope) => OnboardingRuntimeStateRecord;
  readonly select: (
    operation: Operation,
  ) => CommonOnboardingVerificationOperation<Key> | { readonly kind: 'extension'; readonly operation: Extra };
  readonly verifyConfig?:
    | ((
        deps: Dependencies,
        operation: Extract<CommonOnboardingVerificationOperation<Key>, { kind: 'set-config' }>,
      ) => OnboardingVerificationItem | undefined)
    | undefined;
  readonly verifyExtra?:
    | ((deps: Dependencies, operation: Extra) => OnboardingVerificationItem | Promise<OnboardingVerificationItem>)
    | undefined;
}
/** Verification reads through the product's bound storage; it grants no authority. */
export function createOnboardingVerifier<
  Key extends string,
  Dependencies extends OnboardingVerificationDependencies<Key>,
  Operation,
  Extra = never,
>(ports: OnboardingVerificationPorts<Key, Dependencies, Operation, Extra>) {
  function verifyConfigOperation(
    deps: Dependencies,
    operation: Extract<CommonOnboardingVerificationOperation<Key>, { kind: 'set-config' }>,
  ): OnboardingVerificationItem {
    const override = ports.verifyConfig?.(deps, operation);
    if (override !== undefined) return override;
    const actual = deps.config.get(operation.key);
    const ok = isDeepEqual(actual, operation.value);

    return {
      id: `config:${operation.key}`,
      status: ok ? 'pass' : 'fail',
      message: ok
        ? `${operation.key} matches the requested onboarding value.`
        : `${operation.key} does not match the requested onboarding value.`,
      target: operation.key,
    };
  }

  function verifyAcknowledgementOperation(
    deps: Dependencies,
    operation: Extract<CommonOnboardingVerificationOperation<Key>, { kind: 'acknowledge' }>,
  ): OnboardingVerificationItem {
    const state = ports.readState(deps.shellPaths, deps.acknowledgementScope ?? 'project');
    if (state.parseError) {
      return {
        id: `acknowledge:${operation.target}`,
        status: 'fail',
        message: `Onboarding acknowledgement state could not be parsed: ${state.parseError}`,
        target: operation.target,
      };
    }

    const actual = state.payload?.acknowledgements[operation.target] ?? false;
    const ok = actual === operation.acknowledged;

    return {
      id: `acknowledge:${operation.target}`,
      status: ok ? 'pass' : 'fail',
      message: ok
        ? `${operation.target} acknowledgement matches the requested onboarding state.`
        : `${operation.target} acknowledgement does not match the requested onboarding state.`,
      target: operation.target,
    };
  }

  async function verifySecretOperation(
    deps: Dependencies,
    operation: Extract<CommonOnboardingVerificationOperation<Key>, { kind: 'set-secret' }>,
  ): Promise<OnboardingVerificationItem> {
    if (!deps.secrets) {
      return {
        id: `secret:${operation.key}`,
        status: 'fail',
        message: 'Secret manager is unavailable.',
        target: operation.key,
      };
    }

    const id = `secret:${operation.key}`;
    if (isGoodVibesSecretReferenceValue(operation.value)) {
      const ok = (await deps.secrets.get(operation.key)) !== null;
      return {
        id,
        status: ok ? 'pass' : 'fail',
        message: ok
          ? `${operation.key} resolves through the stored GoodVibes secret reference.`
          : `${operation.key} was stored as a GoodVibes secret reference, but the reference resolves to nothing.`,
        target: operation.key,
      };
    }
    if (!deps.secrets.getFromScope) {
      return { id, status: 'fail', message: 'Secret manager cannot read one scope, so the stored key cannot be checked.', target: operation.key };
    }
    // The write targeted one scope; the check reads that scope, not whichever
    // copy (an exported variable, another store) wins when the key is used.
    const scope = operation.scope ?? 'project';
    const stored = await deps.secrets.getFromScope(operation.key, scope);
    if (stored !== operation.value) {
      return { id, status: 'fail', message: `${operation.key} was not found in the ${scope} secret store after it was written.`, target: operation.key };
    }
    const effective = await deps.secrets.get(operation.key);
    if (effective !== operation.value) {
      const overriddenBy = Object.hasOwn(process.env, operation.key)
        ? `the environment variable ${operation.key}`
        : 'a copy in another secret store that is read first';
      return {
        id,
        status: 'warn',
        message: `${operation.key} was stored in the ${scope} secret store, but ${overriddenBy} overrides it in this shell. Remove that copy to use the stored key.`,
        target: operation.key,
      };
    }
    return { id, status: 'pass', message: `${operation.key} was stored through the secret manager.`, target: operation.key };
  }

  function verifyAuthOperation(
    deps: Dependencies,
    operation: Extract<CommonOnboardingVerificationOperation<Key>, { kind: 'ensure-auth-user' }>,
  ): OnboardingVerificationItem {
    if (!deps.auth) {
      return {
        id: `auth:${operation.username}`,
        status: 'fail',
        message: 'Local auth manager is unavailable.',
        target: operation.username,
      };
    }

    const snapshot = deps.auth.inspect();
    const username = operation.username.trim();
    const user = snapshot.users.find((entry) => entry.username === username);
    const requiredRoles = operation.roles ?? ['admin'];
    const userExists = user !== undefined && requiredRoles.every((role) => user.roles.includes(role));
    const sessionExists = operation.createSession === false ? true : snapshot.sessions.some((session) => session.username === username);
    const bootstrapRetired = operation.retireBootstrapCredential ? snapshot.bootstrapCredentialPresent === false : true;
    const ok = userExists && sessionExists && bootstrapRetired;
    return {
      id: `auth:${username}`,
      status: ok ? 'pass' : 'fail',
      message: ok
        ? `${username} local auth user has required role(s) and session state.`
        : `${username} local auth user/session/role/bootstrap state was not created.`,
      target: username,
    };
  }
  async function verifyOperation(deps: Dependencies, input: Operation): Promise<OnboardingVerificationItem> {
    const operation = ports.select(input);
    if (operation.kind === 'extension') {
      if (!ports.verifyExtra) throw new Error('Onboarding extension verifier is unavailable.');
      return ports.verifyExtra(deps, operation.operation);
    }
    if (operation.kind === 'set-config') return verifyConfigOperation(deps, operation);
    if (operation.kind === 'set-secret') return verifySecretOperation(deps, operation);
    if (operation.kind === 'ensure-auth-user') return verifyAuthOperation(deps, operation);
    return verifyAcknowledgementOperation(deps, operation);
  }
  return async <Request extends { readonly operations: readonly Operation[] }>(
    deps: Dependencies,
    request: Request,
  ): Promise<OnboardingVerificationResult> => {
    const items = await Promise.all(request.operations.map((operation) => verifyOperation(deps, operation)));
    return { verifiedAt: deps.clock?.() ?? Date.now(), ok: items.every((item) => item.status !== 'fail'), items };
  };
}

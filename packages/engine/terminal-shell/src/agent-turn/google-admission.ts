import type { ConfigManager, SecretsManager } from '@goodvibes/engine/platform/platform/config';
import { GOOGLE_SECRET_KEYS } from '@goodvibes/engine/platform/platform/google';
import { assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector } from '@goodvibes/engine/platform/platform/tools';
import type { Tool } from '@goodvibes/engine/platform/platform/types';

export interface GoogleAdmissionOwners {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
}

/**
 * Admits an effect on the stored Google credentials once: both must be
 * readable and no credential write may be in flight. Afterwards the check is
 * the owners' identity only; a credential or client-setting change during the
 * call is the Google connection owner's revision, which the tool compares.
 */
export function retainGoogleConnectionOwners(owners: GoogleAdmissionOwners): () => void {
  const config = owners.configManager, secrets = owners.secretsManager;
  if (secrets.getCredentialMutationState().pending) throw new ToolInputProjectionError('held');
  for (const key of [GOOGLE_SECRET_KEYS.oauthClientSecret, GOOGLE_SECRET_KEYS.oauthRefreshToken]) {
    if (secrets.resolveLocalCredentialSnapshot(key).state === 'unsupported') throw new ToolInputProjectionError('held');
  }
  return () => {
    if (owners.configManager !== config || owners.secretsManager !== secrets) throw new ToolInputProjectionError('stale');
  };
}

const effectSources = new WeakMap<object, { readonly argsJson: string; readonly assertCurrent: () => void }>();
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/**
 * The `google` tool's input projection: a send or a calendar write is bound to
 * the stores that admitted it. Connecting is not an action of the tool (it is
 * the daemon's work, `capabilities/builtin/google.ts`), so nothing here stores
 * a client or a credential.
 */
export function createGoogleSettingsProjector(owners: GoogleAdmissionOwners): ToolInputProjector {
  return { async project(request) {
    const action = text(request.args.action).toLowerCase();
    if (action !== 'mail.send' && action !== 'calendar.create') return { status: 'projected', args: request.args };
    request.assertCurrent(); request.signal?.throwIfAborted();
    const nativeCurrent = retainGoogleConnectionOwners(owners);
    const assertCurrent = () => { request.signal?.throwIfAborted(); nativeCurrent(); };
    const context = Object.freeze({}), argsJson = JSON.stringify(request.args);
    effectSources.set(context, { argsJson, assertCurrent });
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
      assertRepairedArgs(next) { assertCurrent(); if (JSON.stringify(next) !== argsJson) throw new ToolInputProjectionError('binding-changed'); },
      async release() { effectSources.delete(context); },
    };
  } };
}

/** This private source restriction cannot replace the original recorded send/write proof. */
export function retainGooglePreparedEffectSource(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1]): () => void {
  const context = options?.inputProjectionContext, retained = context && effectSources.get(context);
  if (!context || !retained) throw new ToolInputProjectionError('held');
  const assertCurrent = () => {
    assertProjectionExecution(context, args);
    if (JSON.stringify(args) !== retained.argsJson) throw new ToolInputProjectionError('binding-changed');
    retained.assertCurrent();
  };
  assertCurrent(); return assertCurrent;
}

/** SETTINGS preconditions bind the real serving config, credential and auth owners. */
import { createSettingsPreconditionHandler, type SettingsPreconditionFacts, type SettingsPreconditionHandler, type SettingsPreconditionRequest } from '@goodvibes/engine/daemon-api';
import { preparedReceiptWrites, type ConfigManager, type PreparedConfigMutation, type PreparedConfigMutationReceipt } from '../../config/manager.js';
import type { PreparedScopedSecretDeletion, SecretsManager } from '../../config/secrets.js';
import { isDaemonOwnedConfigKey } from '../../config/config-ownership.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { daemonSecretKeyFor } from '../../config/daemon-secret-keys.js';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { extractOperatorAuthToken } from '../../security/http-auth.js';
import type { DaemonControlPlaneHelper } from '../control-plane.js';

export interface ServingSettingsAuthority {
  readonly settingsLifetime: () => object | null;
  readonly captureSettingsAdminAuthority: DaemonControlPlaneHelper['captureSettingsAdminAuthority'];
  readonly withSettingsAdminAuthority: DaemonControlPlaneHelper['withSettingsAdminAuthority'];
}
export type ServingSettingsSecrets = Pick<SecretsManager, 'prepareScopedDeletion' | 'inspectPreparedScopedDeletion' | 'assertPreparedScopedDeletion' | 'withPreparedScopedDeletion' | 'assertCompletedScopedDeletion'>;
type FinishSecret = (assertCurrent: () => void) => PreparedConfigMutationReceipt;
interface Prepared {
  readonly config: PreparedConfigMutation;
  readonly operation: SettingsPreconditionRequest['operation'];
  readonly secret?: { readonly owner: ServingSettingsSecrets; readonly handle: PreparedScopedSecretDeletion; readonly scope: 'daemon' | 'user' };
  finishSecret?: FinishSecret;
  /** Every possible effect in publication order (configuration first, then the credential), fixed when facts are inspected. */
  destinations?: SettingsPreconditionFacts['destinations'];
}
export function createServingSettingsPrecondition(
  manager: ConfigManager,
  authority: ServingSettingsAuthority,
  secrets: () => ServingSettingsSecrets | null = () => null,
  assertServingOwner: () => void = () => {},
): SettingsPreconditionHandler {
  const assertSecretOwner = (prepared: Prepared) => {
    assertServingOwner();
    if (prepared.secret && secrets() !== prepared.secret.owner) throw new Error('Credential owner changed.');
  };
  return createSettingsPreconditionHandler({
    lifetime: authority.settingsLifetime,
    captureAuthority: (req) => authority.captureSettingsAdminAuthority(req),
    withAuthority: (req, captured, callback) => authority.withSettingsAdminAuthority(req, captured, callback),
    caller: extractOperatorAuthToken,
    owner: {
      prepare(request): Prepared {
        assertServingOwner();
        const setting = manager.getSchema().find(entry => entry.key === request.key);
        if (!setting) throw new Error('Setting unavailable');
        const value = request.operation === 'reset-default' ? setting.default : request.value;
        const safe = snapshotJudgmentInput({ mode: 'set', key: setting.key, value }, 'goodvibes_settings') as { value: unknown };
        const config = manager.prepareSettingMutation({ operation: 'set', key: setting.key, value: safe.value });
        if (!request.credentialClear) return { config, operation: request.operation };
        // The caller cannot name a credential or widen its scope. References
        // are config-only; clear/reset bind the exact derived credential.
        if (!isSecretBearingConfigKey(setting.key) || (request.operation === 'set' && safe.value !== '')) throw new Error('Credential clear unavailable');
        const owner = secrets();
        if (!owner) throw new Error('Credential owner unavailable');
        const scope = isDaemonOwnedConfigKey(setting.key) ? 'daemon' : 'user';
        const handle = owner.prepareScopedDeletion(daemonSecretKeyFor(setting.key), scope);
        return { config, operation: request.operation, secret: { owner, handle, scope } };
      },
      inspect(prepared): SettingsPreconditionFacts {
        const facts = manager.inspectPreparedMutation(prepared.config);
        const safe = snapshotJudgmentInput({ mode: 'set', key: facts.key, value: facts.value }, 'goodvibes_settings') as { value: unknown };
        const credential = prepared.secret ? prepared.secret.owner.inspectPreparedScopedDeletion(prepared.secret.handle) : null;
        // Configuration is published first and the credential second: a failure between
        // them leaves an orphan credential, never configuration that points at a deleted one.
        const destinations = Object.freeze([...facts.destinations, ...(credential?.destinations ?? [])]);
        prepared.destinations = destinations;
        return Object.freeze({ operation: prepared.operation, key: facts.key, incarnation: facts.incarnation, value: safe.value,
          destinations,
          ...(credential && prepared.secret ? { credentialClear: true as const, credential: Object.freeze({ key: credential.key,
            scope: prepared.secret.scope, destinations: credential.destinations }) } : {}) });
      },
      assert(prepared) {
        manager.assertPreparedMutation(prepared.config); assertSecretOwner(prepared);
        // Acquiring locks spends the secret handle. Its one-use finish rechecks
        // the exact generation, policy and store observations before writing.
        if (prepared.secret && !prepared.finishSecret) prepared.secret.owner.assertPreparedScopedDeletion(prepared.secret.handle);
      },
      async withPrepared(prepared, operation) {
        if (!prepared.secret) return operation();
        assertSecretOwner(prepared);
        return prepared.secret.owner.withPreparedScopedDeletion(prepared.secret.handle, finish => {
          prepared.finishSecret = finish;
          try { return operation(); } finally { delete prepared.finishSecret; }
        });
      },
      begin: (prepared) => manager.beginPreparedMutation(prepared.config),
      assertTransition(prepared, transition) { assertSecretOwner(prepared); manager.assertPreparedMutationTransition(prepared.config, transition); },
      finish(prepared, transition, assertCurrent) {
        const facts = manager.inspectPreparedMutation(prepared.config);
        const order = prepared.destinations ?? facts.destinations;
        const completedPaths: string[] = [];
        const assertConfigBound = () => {
          assertCurrent(); assertSecretOwner(prepared); manager.assertPreparedMutationTransition(prepared.config, transition);
        };
        let receipt: PreparedConfigMutationReceipt;
        try {
          assertConfigBound();
          receipt = manager.finishPreparedMutation(prepared.config, transition, assertConfigBound); }
        catch {
          return Object.freeze({ status: 'unknown' as const, completedPaths: Object.freeze(completedPaths), uncertainPath: order[0]!.path });
        }
        completedPaths.push(...receipt.completedPaths);
        if (receipt.status !== 'committed') return Object.freeze({ ...receipt,
          status: completedPaths.length ? 'partial' as const : 'unknown' as const, completedPaths: Object.freeze(completedPaths) });
        if (prepared.secret) {
          if (!prepared.finishSecret) throw new Error('Credential ownership unavailable');
          // The configuration change is already published; the credential step may
          // only be gated on that fact, never on the (now spent) config transition.
          const assertSecretBound = () => { assertCurrent(); assertSecretOwner(prepared); manager.assertCompletedMutation(prepared.config); };
          let secretReceipt: PreparedConfigMutationReceipt;
          try { secretReceipt = prepared.finishSecret(assertSecretBound); }
          catch {
            return Object.freeze({ status: 'partial' as const, completedPaths: Object.freeze(completedPaths), uncertainPath: order[completedPaths.length]!.path });
          }
          completedPaths.push(...secretReceipt.completedPaths);
          if (secretReceipt.status !== 'committed') {
            const uncertainPath = secretReceipt.uncertainPath ?? order[completedPaths.length]?.path;
            return Object.freeze({ ...secretReceipt, status: 'partial' as const,
              completedPaths: Object.freeze(completedPaths), ...(uncertainPath === undefined ? {} : { uncertainPath }) });
          }
        }
        let verifiedInOwningStore = false;
        try {
          // Pure reporting only: the config receipt carries what each file now
          // holds, read from the document the commit wrote; nothing is re-read.
          assertSecretOwner(prepared);
          if (prepared.secret) prepared.secret.owner.assertCompletedScopedDeletion(prepared.secret.handle);
          const written = preparedReceiptWrites(receipt);
          verifiedInOwningStore = facts.destinations.every(destination => {
            const found = written.find(entry => entry.path === destination.path && entry.key === facts.key);
            if (!found) return destination.operation === 'remove';
            return destination.operation === 'remove' ? !found.present
              : found.present && JSON.stringify(found.value) === JSON.stringify(facts.value);
          });
        } catch { /* A failed owner check never undoes the truthful receipt. */ }
        return Object.freeze({ status: 'committed' as const, completedPaths: Object.freeze(completedPaths), verifiedInOwningStore });
      },
    },
  });
}

/**
 * The daemon side of a settings import: the credential is stored before the
 * setting that points at it, each owner (secret store, config manager) does
 * its own compare-and-write under its own lock, and the receipt names what was
 * written. The import is admitted once, by the caller's own gate when the
 * caller is an agent; a paired admin's request, or one from an app on the
 * daemon's own machine with the operator token it holds, is not judged a
 * second time here. The owner authority is read once, immediately before the
 * write.
 */
import { createSettingsImportPreconditionHandler, type SettingsImportPreconditionFacts, type SettingsImportPreconditionHandler } from '@goodvibes-jev/engine/daemon-api';
import type { ConfigManager, PreparedConfigMutation, PreparedConfigMutationTransition, PreparedConfigMutationReceipt } from '../../config/manager.js';
import type { SecretsManager, PreparedSecretImport, SecretImportEntry } from '../../config/secrets.js';
import { isDaemonOwnedConfigKey } from '../../config/config-ownership.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { isSecretRefInput } from '../../config/secret-refs.js';
import { daemonSecretKeyFor } from '../../config/daemon-secret-keys.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import type { ExternalPermissionHost } from '../../permissions/external-request.js';
import { confirmFileDurable } from '../../utils/atomic-json-store.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../../security/http-auth.js';
import type { DaemonControlPlaneHelper, SettingsAdminAuthority } from '../control-plane.js';
import type { ServingSettingsAuthority } from './settings-precondition.js';
import { missingScopes } from './route-helpers.js';

export interface ServingSettingsImportAuthority extends ServingSettingsAuthority {
  readonly captureNativeExecutionAuthority: (req: Request) => NativeExecutionAuthority | null;
  readonly extractAuthToken: DaemonControlPlaneHelper['extractAuthToken'];
  readonly requireAdmin: DaemonControlPlaneHelper['requireAdmin'];
}
export type ServingSettingsImportSecrets = Pick<SecretsManager, 'prepareImport' | 'inspectPreparedImport' | 'assertPreparedImport' | 'withPreparedImport' | 'assertCompletedImport'>;
interface Prepared {
  readonly config: PreparedConfigMutation;
  readonly facts: SettingsImportPreconditionFacts;
  readonly host: ExternalPermissionHost;
  readonly secret?: { readonly owner: ServingSettingsImportSecrets; readonly handle: PreparedSecretImport };
  transition?: PreparedConfigMutationTransition;
  finishSecret?: (assertCurrent: () => void) => PreparedConfigMutationReceipt;
  secretCompleted?: true;
  configCompleted?: true;
}
interface Authority {
  readonly admin: SettingsAdminAuthority;
  readonly native: NativeExecutionAuthority;
  readonly expected: NativePairedSnapshot;
  readonly token: string;
}
const SCOPE = 'write:config';
function allowed(snapshot: NativePairedSnapshot | null): snapshot is NativePairedSnapshot {
  return snapshot !== null && (snapshot.kind === 'pairing-token' || snapshot.kind === 'local') && missingScopes(snapshot.scopes, [SCOPE]).length === 0;
}
function samePairedAuthority(current: NativePairedSnapshot, expected: NativePairedSnapshot): boolean {
  return current.principalId === expected.principalId && current.tokenId === expected.tokenId
    && current.authorityId === expected.authorityId && current.authorityRevision === expected.authorityRevision;
}
export function createServingSettingsImportPrecondition(input: {
  readonly manager: ConfigManager;
  readonly authority: ServingSettingsImportAuthority;
  readonly secrets: () => ServingSettingsImportSecrets | null;
  readonly host: () => ExternalPermissionHost | undefined;
  readonly assertServingOwner: () => void;
}): SettingsImportPreconditionHandler {
  const { manager, authority } = input;
  // The owners' own state checks: each is an in-memory compare, no file is read.
  const assertPrepared = (prepared: Prepared) => {
    prepared.host.signal.throwIfAborted();
    manager.assertSettingsWritable();
    if (prepared.configCompleted) manager.assertCompletedMutation(prepared.config);
    else if (prepared.transition) manager.assertPreparedMutationTransition(prepared.config, prepared.transition);
    else manager.assertPreparedMutation(prepared.config);
    if (prepared.secretCompleted && prepared.secret) prepared.secret.owner.assertCompletedImport(prepared.secret.handle);
    else if (prepared.secret && !prepared.finishSecret) prepared.secret.owner.assertPreparedImport(prepared.secret.handle);
  };
  // Revocation is checked here once, right before the write; the token and the
  // paired record are what can change while a request waits.
  const assertAuthority = (req: Request, captured: Authority) => {
    input.assertServingOwner(); req.signal.throwIfAborted();
    const current = captured.native.current();
    if (authority.extractAuthToken(req) !== captured.token || !allowed(current) || !samePairedAuthority(current, captured.expected)) {
      throw new Error('Native settings import authority changed');
    }
  };
  return createSettingsImportPreconditionHandler({
    lifetime: authority.settingsLifetime,
    caller: (req) => authority.extractAuthToken(req),
    captureAuthority(req): Authority | null {
      const admin = authority.captureSettingsAdminAuthority(req), native = authority.captureNativeExecutionAuthority(req), expected = native?.current();
      // A paired device's own credential, or the operator token from this machine (whose native authority is the local owner's).
      const adminMatches = admin?.kind === (expected?.kind === 'local' ? 'shared-token' : 'pairing-token');
      if (!admin || !adminMatches || !native || !expected || !allowed(expected) || authority.requireAdmin(req) !== null) return null;
      return Object.freeze({ admin, native, expected, token: authority.extractAuthToken(req) });
    },
    withAuthority(req, captured, operation) {
      assertAuthority(req, captured);
      return authority.withSettingsAdminAuthority(req, captured.admin, check => operation(check));
    },
    // The caller's gate is the one admission; this lane only binds the request's lifetime.
    async admit(req, _captured, prepared, assertBound, apply) {
      const signal = AbortSignal.any([prepared.host.signal, req.signal]);
      const current = () => { signal.throwIfAborted(); assertBound(); };
      return apply(() => {}, current);
    },
    owner: {
      prepare(request): Prepared {
        input.assertServingOwner();
        const host = input.host();
        if (!host) throw new Error('Native settings import owner unavailable');
        const schema = manager.getSchema(), entries: SecretImportEntry[] = [];
        if (request.settings.length > schema.length || new Set(request.settings.map(entry => entry.key)).size !== request.settings.length) throw new Error('Native settings import invalid');
        const changes = request.settings.map(entry => {
          const setting = schema.find(setting => setting.key === entry.key);
          if (!setting || !isDaemonOwnedConfigKey(setting.key)) throw new Error('Native settings import invalid');
          let value = captureOwnedJson(entry.value);
          if (isSecretBearingConfigKey(setting.key)) {
            if (typeof value !== 'string') throw new Error('Native credential setting invalid');
            const normalized = value.trim(), key = daemonSecretKeyFor(setting.key);
            if (!normalized) { value = ''; entries.push({ key, scope: 'daemon', operation: 'delete' }); }
            else if (normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized)) value = normalized;
            else if (normalized.startsWith('goodvibes://')) throw new Error('Native credential reference invalid');
            // The credential goes to the secret store; the setting and the facts carry only its reference.
            else { entries.push({ key, scope: 'daemon', value }); value = `goodvibes://secrets/goodvibes/${key}`; }
          }
          // Undeclared inline credential/card material cannot cross even this private-to-public boundary.
          const safe = snapshotJudgmentInput({ operation: 'set', key: setting.key, value }, 'goodvibes_settings') as { value: unknown };
          return { operation: 'set' as const, key: setting.key, value: safe.value };
        });
        const config = manager.prepareSettingMutationPlan(changes);
        manager.protectPreparedMutationTargets(config);
        const configFacts = manager.inspectPreparedMutation(config);
        const secretOwner = input.secrets();
        if (entries.length && !secretOwner) throw new Error('Native credential owner unavailable');
        const secret = entries.length && secretOwner ? { owner: secretOwner, handle: secretOwner.prepareImport(entries) } : undefined;
        const credential = secret?.owner.inspectPreparedImport(secret.handle);
        const effects = (configFacts.effects ?? [configFacts]).map(effect => {
          if (effect.operation !== 'set') throw new Error('Native settings import invalid');
          return Object.freeze({ operation: 'set' as const, key: effect.key, value: effect.value, destinations: effect.destinations });
        });
        // A credential value goes to the secret store only; the same text as the
        // value of an ordinary setting would put it in a config file and in the
        // facts. An exact match, so a short secret that happens to occur inside a
        // path or a key name is not mistaken for one.
        const credentialValues = new Set(entries.flatMap(entry => entry.operation !== 'delete' && entry.value ? [entry.value] : []));
        const duplicated = effects.find(effect => typeof effect.value === 'string' && credentialValues.has(effect.value));
        if (duplicated) throw new Error(`Native settings import invalid: ${duplicated.key} repeats a credential being imported`);
        // Credential values are references here, so the facts carry keys, references, other setting values and paths.
        const facts: SettingsImportPreconditionFacts = Object.freeze({ operation: 'import', effects: Object.freeze(effects), incarnation: configFacts.incarnation,
          destinations: Object.freeze([...(credential?.destinations ?? []), ...configFacts.destinations]),
          ...(credential ? { credential: Object.freeze({ items: Object.freeze(credential.items.map(item => {
            if (item.scope !== 'daemon') throw new Error('Native credential scope invalid');
            return Object.freeze({ key: item.key, scope: item.scope, configured: item.configured });
          })), destinations: credential.destinations }) } : {}) });
        const prepared = { config, facts, host, ...(secret ? { secret } : {}) }; assertPrepared(prepared); return prepared;
      },
      inspect: prepared => prepared.facts,
      assert: assertPrepared,
      async withPrepared(prepared, operation, current) {
        assertPrepared(prepared); current();
        if (!prepared.secret) return operation();
        return prepared.secret.owner.withPreparedImport(prepared.secret.handle, finish => {
          prepared.finishSecret = finish;
          try { current(); return operation(); } finally { delete prepared.finishSecret; }
        }, current);
      },
      begin(prepared) { const transition = manager.beginPreparedMutation(prepared.config); prepared.transition = transition; return transition; },
      assertTransition(prepared, transition) { manager.assertPreparedMutationTransition(prepared.config, transition); },
      finish(prepared, transition, assertCurrent) {
        const completedPaths: string[] = [];
        const settingsPath = prepared.facts.effects[0]?.destinations[0]?.path;
        const credentialPath = prepared.facts.credential?.destinations[0]?.path;
        // Written files are confirmed durable; nothing is re-checked after a write.
        const confirm = (paths: readonly string[]): string | null => {
          for (const path of paths) {
            try { confirmFileDurable(path); } catch { return path; }
          }
          return null;
        };
        if (prepared.secret) {
          if (!prepared.finishSecret) throw new Error('Native credential publication unavailable');
          const receipt = prepared.finishSecret(assertCurrent); completedPaths.push(...receipt.completedPaths);
          if (receipt.status !== 'committed') {
            // The credential step is the uncertain one, so the caller is pointed at the credential store.
            const uncertainPath = receipt.uncertainPath ?? credentialPath;
            return Object.freeze({ ...receipt, ...(uncertainPath ? { uncertainPath } : {}) });
          }
          prepared.secretCompleted = true;
          const uncertainPath = confirm(receipt.completedPaths);
          if (uncertainPath !== null) return Object.freeze({ status: 'partial', completedPaths: Object.freeze(completedPaths), uncertainPath });
        }
        let receipt: PreparedConfigMutationReceipt;
        try { receipt = manager.finishPreparedMutation(prepared.config, transition, assertCurrent); }
        catch {
          return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths), ...(settingsPath ? { uncertainPath: settingsPath } : {}) });
        }
        completedPaths.push(...receipt.completedPaths);
        if (receipt.status !== 'committed') return Object.freeze({ ...receipt, status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths) });
        prepared.configCompleted = true;
        const uncertainPath = confirm(receipt.completedPaths);
        if (uncertainPath !== null) return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths), uncertainPath });
        let verifiedInOwningStore = false;
        try { manager.assertCompletedMutation(prepared.config); if (prepared.secret) prepared.secret.owner.assertCompletedImport(prepared.secret.handle); verifiedInOwningStore = true; }
        catch { /* The completed durable receipt survives a reporting failure. */ }
        return Object.freeze({ status: 'committed', completedPaths: Object.freeze(completedPaths), verifiedInOwningStore });
      },
    },
  });
}

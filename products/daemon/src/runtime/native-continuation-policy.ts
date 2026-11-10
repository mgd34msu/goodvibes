/** Fresh policy tuples compare exact ordinary revisions. Actual saved CI1 grants
 * retain their independently expected private-frame verification recipe. */
import { createHash } from 'node:crypto';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

type ConfigurationOwner = Pick<ConfigManager, 'captureDurableConfigurationIncarnation' | 'getDurableConfigurationIncarnation' | 'onDidChangeIncarnation'>;
interface ScopeOwner { current(version?: 1 | 2): { readonly revision: string; readonly scopes: readonly string[] } }
interface PolicySnapshot { readonly configuration: string; readonly scope: string }
const CHANGED = 'native-continuation-policy-changed';

export function createDaemonContinuationPolicy(configuration: ConfigurationOwner, scope: ScopeOwner) {
  // Bind the original readers before a later callback can replace them. A new
  // owner is a new policy, not an alternate reader for a previously issued act.
  const capture = configuration.captureDurableConfigurationIncarnation.bind(configuration);
  const current = configuration.getDurableConfigurationIncarnation.bind(configuration);
  const readScope = scope.current.bind(scope);
  const subscribe = configuration.onDidChangeIncarnation.bind(configuration);
  const methods = { capture: configuration.captureDurableConfigurationIncarnation, current: configuration.getDurableConfigurationIncarnation,
    scope: scope.current, subscribe: configuration.onDidChangeIncarnation };
  let snapshot: PolicySnapshot | undefined;
  let savedSnapshot: PolicySnapshot | undefined, savedBinding: string | undefined;
  let retired = false;
  const assertReaders = () => {
    if (retired || configuration.captureDurableConfigurationIncarnation !== methods.capture || configuration.getDurableConfigurationIncarnation !== methods.current
      || scope.current !== methods.scope || configuration.onDidChangeIncarnation !== methods.subscribe) {
      retired = true;
      throw new Error('Native continuation policy owner changed');
    }
  };
  const read = (establish: boolean, version: 1 | 2 = 2) => {
    assertReaders();
    const configurationRevision = establish ? capture() : current(version), selected = readScope(version);
    assertReaders();
    if (typeof configurationRevision !== 'string' || !configurationRevision || typeof selected.revision !== 'string' || !selected.revision) {
      throw new Error('Native continuation policy revision is unavailable');
    }
    return { configuration: configurationRevision, scope: selected.revision };
  };
  const same = (value: { readonly configuration: string; readonly scope: string }): boolean =>
    snapshot !== undefined && value.configuration === snapshot.configuration && value.scope === snapshot.scope;
  const establish = (value: { readonly configuration: string; readonly scope: string }): void => {
    snapshot = Object.freeze({ ...value });
  };
  const binding = (version: 1 | 2): string => {
    if (!snapshot) throw new Error('Native continuation policy is unavailable');
    if (version === 1) throw new Error('Historical native continuation policy requires fresh issuance');
    return JSON.stringify([snapshot.configuration, snapshot.scope]);
  };
  return Object.freeze({
    capture(version: 1 | 2 = 2): string {
      if (version === 1) { assertReaders(); throw new Error('Historical native continuation policy requires fresh issuance'); }
      const selected = read(true); if (!same(selected)) establish(selected); return binding(version);
    },
    current(version: 1 | 2 = 2): string {
      if (version === 1) {
        const selected = read(false, 1);
        if (!savedSnapshot || selected.configuration !== savedSnapshot.configuration || selected.scope !== savedSnapshot.scope) {
          savedSnapshot = Object.freeze(selected); savedBinding = undefined;
        }
        return savedBinding ??= createHash('sha256').update(JSON.stringify([selected.configuration, selected.scope])).digest('hex');
      }
      const selected = read(false);
      if (!snapshot) establish(selected);
      return same(selected) ? binding(version) : CHANGED;
    },
    scopes(): readonly string[] { assertReaders(); const selected = readScope(); assertReaders(); return selected.scopes; },
    onDidInvalidate(listener: () => void): () => void { assertReaders(); return subscribe(listener); },
  });
}

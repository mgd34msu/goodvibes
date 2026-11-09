/** Compare actual configuration/scope incarnations directly. Fresh CI2 stores
 * their exact opaque revision tuple; old CI1 grants retain their original
 * digest recipe only on actual legacy capture/adoption, never every guard. */
import { createHash } from 'node:crypto';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

type ConfigurationOwner = Pick<ConfigManager, 'captureDurableConfigurationIncarnation' | 'getDurableConfigurationIncarnation' | 'onDidChangeIncarnation'>;
interface ScopeOwner { current(): { readonly revision: string; readonly scopes: readonly string[] } }
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
  let snapshot: PolicySnapshot | undefined; let legacyBinding: string | undefined;
  let retired = false;
  const assertReaders = () => {
    if (retired || configuration.captureDurableConfigurationIncarnation !== methods.capture || configuration.getDurableConfigurationIncarnation !== methods.current
      || scope.current !== methods.scope || configuration.onDidChangeIncarnation !== methods.subscribe) {
      retired = true;
      throw new Error('Native continuation policy owner changed');
    }
  };
  const read = (establish: boolean) => {
    assertReaders();
    const configurationRevision = establish ? capture() : current(), selected = readScope();
    assertReaders();
    if (typeof configurationRevision !== 'string' || !configurationRevision || typeof selected.revision !== 'string' || !selected.revision) {
      throw new Error('Native continuation policy revision is unavailable');
    }
    return { configuration: configurationRevision, scope: selected.revision };
  };
  const same = (value: { readonly configuration: string; readonly scope: string }): boolean =>
    snapshot !== undefined && value.configuration === snapshot.configuration && value.scope === snapshot.scope;
  const establish = (value: { readonly configuration: string; readonly scope: string }): void => {
    snapshot = Object.freeze({ ...value }); legacyBinding = undefined;
  };
  const binding = (version: 1 | 2): string => {
    if (!snapshot) throw new Error('Native continuation policy is unavailable');
    if (version === 2) return JSON.stringify([snapshot.configuration, snapshot.scope]);
    // Existing private CI1 grants independently compare this exact saved value.
    return legacyBinding ??= createHash('sha256').update(JSON.stringify([snapshot.configuration, snapshot.scope])).digest('hex');
  };
  return Object.freeze({
    capture(version: 1 | 2 = 1): string {
      const selected = read(true); if (!same(selected)) establish(selected); return binding(version);
    },
    current(version: 1 | 2 = 1): string {
      const selected = read(false);
      if (!snapshot) establish(selected);
      return same(selected) ? binding(version) : CHANGED;
    },
    scopes(): readonly string[] { assertReaders(); const selected = readScope(); assertReaders(); return selected.scopes; },
    onDidInvalidate(listener: () => void): () => void { assertReaders(); return subscribe(listener); },
  });
}

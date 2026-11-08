/** Compare live native owners directly. The v1 digest remains only at the
 * durable-format boundary: issuing a binding, or opening a previously issued
 * one after restart. Rechecking unchanged owners does not rehash their IDs. */
import { createHash } from 'node:crypto';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

type ConfigurationOwner = Pick<ConfigManager, 'captureDurableConfigurationIncarnation' | 'getDurableConfigurationIncarnation' | 'onDidChangeIncarnation'>;
interface ScopeOwner { current(): { readonly revision: string; readonly scopes: readonly string[] } }
interface PolicySnapshot { readonly configuration: string; readonly scope: string; readonly binding: string }
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
  const establish = (value: { readonly configuration: string; readonly scope: string }): string => {
    // Existing v1 continuation grants bind this exact array representation.
    // This is still an open persistence-format migration, not authentication
    // supplied by a hash or a justification for hashes on every live guard.
    snapshot = Object.freeze({ ...value, binding: createHash('sha256').update(JSON.stringify([value.configuration, value.scope])).digest('hex') });
    return snapshot.binding;
  };
  return Object.freeze({
    capture(): string {
      const selected = read(true);
      return same(selected) && snapshot ? snapshot.binding : establish(selected);
    },
    current(): string {
      const selected = read(false);
      // On recovery there is no live snapshot yet. Read-only observation of
      // actual durable revisions reconstructs the pre-existing v1 binding;
      // it does not call capture() to fabricate missing owner history.
      if (!snapshot) return establish(selected);
      return same(selected) ? snapshot.binding : CHANGED;
    },
    scopes(): readonly string[] { assertReaders(); const selected = readScope(); assertReaders(); return selected.scopes; },
    onDidInvalidate(listener: () => void): () => void { assertReaders(); return subscribe(listener); },
  });
}

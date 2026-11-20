/** Fresh policy tuples compare exact ordinary revisions. Actual saved CI1 grants
 * retain their independently expected private-frame verification recipe. */
import { createHash } from 'node:crypto';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';

type ConfigurationOwner = Pick<ConfigManager, 'captureDurableConfigurationIncarnation' | 'getDurableConfigurationIncarnation'>;
interface ScopeOwner { current(version?: 1 | 2): { readonly revision: string; readonly scopes: readonly string[] } }
interface PolicySnapshot { readonly configuration: string; readonly scope: string }
const CHANGED = 'native-continuation-policy-changed';

export function createDaemonContinuationPolicy(configuration: ConfigurationOwner, scope: ScopeOwner) {
  let snapshot: PolicySnapshot | undefined;
  let savedSnapshot: PolicySnapshot | undefined, savedBinding: string | undefined;
  // The configuration owner's durable revision survives a restart, so a grant
  // saved before one is compared against the same counter after it.
  const read = (establish: boolean, version: 1 | 2 = 2) => {
    const configurationRevision = establish ? configuration.captureDurableConfigurationIncarnation() : configuration.getDurableConfigurationIncarnation();
    const selected = scope.current(version);
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
      if (version === 1) throw new Error('Historical native continuation policy requires fresh issuance');
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
    scopes(): readonly string[] { return scope.current().scopes; },
  });
}

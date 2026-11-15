import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

/**
 * The settings as read now, and a check that they have not changed since. The
 * config manager owns that fact as one integer (its incarnation, moved by every
 * change, save and reload), so the check is one compare.
 */
export function retainCliConfig(manager: Pick<ConfigManager, 'getRaw' | 'getConfigurationIncarnation'>) {
  const incarnation = manager.getConfigurationIncarnation();
  const raw = manager.getRaw();
  const assertCurrent = () => {
    if (manager.getConfigurationIncarnation() !== incarnation) {
      throw new Error('Settings changed while this was being read; nothing was done. Run it again to use the current settings.');
    }
  };
  return { raw, assertCurrent };
}

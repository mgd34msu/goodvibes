import { createSettingsValueHelpers } from '@goodvibes/engine/terminal-shell/renderer/settings-value-helpers';
export { inferSubscriptionRouteReason } from '@goodvibes/engine/terminal-shell/settings-subscriptions';
/**
 * Value words, names and colors for the settings screen. Every name is the
 * setting's own label (or its feature's name); every value reads in words.
 */

import type { SettingEntry } from '../input/settings-modal-types.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import { isDaemonOwnedConfigKey } from '@goodvibes/engine/platform/platform/config';

export const { formatValue, formatDefault, valueColor, getSettingLabel } = createSettingsValueHelpers<SettingEntry>({
  isSecretKey: isSecretConfigKey,
  isDaemonKept: isDaemonOwnedConfigKey,
});

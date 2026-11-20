import { createSettingsValueHelpers } from '@goodvibes/engine/terminal-shell/renderer/settings-value-helpers';
export { inferSubscriptionRouteReason } from '@goodvibes/engine/terminal-shell/settings-subscriptions';
/**
 * Value words, names and colors for the settings screen. Every name is the
 * setting's own label (or its feature's name); every value reads in words.
 */

import type { SettingEntry } from '../input/settings-modal-types.ts';
import { isSecretConfigKey, isSecretReferenceValue } from '../config/secret-config.ts';

export const { formatValue, formatDefault, valueColor, getSettingLabel } = createSettingsValueHelpers<SettingEntry>({
  isSecretKey: isSecretConfigKey,
  isSecretReference: isSecretReferenceValue,
});

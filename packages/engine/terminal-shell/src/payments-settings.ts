/** Payment settings rows share the same daemon-backed references across terminal surfaces. */
import type { ConfigManager, ConfigKey, ConfigSetting } from '@goodvibes-jev/engine/platform/platform/config';
import {
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
} from '@goodvibes-jev/engine/platform/platform/config';
export {
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
  PAYMENTS_CVV_HANDLING_CONFIG_KEY,
  PAYMENTS_ADDRESS_FIELD_SUFFIXES,
  PAYMENTS_SYNTHETIC_CONFIG_KEYS,
  paymentsAddressConfigKey,
  paymentsAddressConfigKeys,
  isPaymentsSyntheticConfigKey,
} from '@goodvibes-jev/engine/platform/platform/config';
export type { PaymentsAddressKind } from '@goodvibes-jev/engine/platform/platform/config';
export type PaymentsConfigReader = Pick<ConfigManager, 'get'>;
export interface PaymentsSettingEntry {
  setting: ConfigSetting;
  currentValue: unknown;
  isDefault: boolean;
}
function readStringField(configManager: PaymentsConfigReader, key: ConfigKey): string {
  // Defensive try/catch, the same posture every synthetic setting in this app
  // takes toward an unexpected value: the real ConfigManager does not throw for
  // these particular keys (see header, flat leaf under an existing section),
  // but degrading to empty is better than taking the whole settings modal down
  // if that ever stops being true.
  try {
    const raw = configManager.get(key);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

function buildStringFieldEntry(configManager: PaymentsConfigReader, key: ConfigKey, description: string): PaymentsSettingEntry {
  const currentValue = readStringField(configManager, key);
  return {
    setting: { key, type: 'string', default: '', description },
    currentValue,
    isDefault: currentValue === '',
  };
}

export function buildPaymentsCardNumberEntry(configManager: PaymentsConfigReader): PaymentsSettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_NUMBER_CONFIG_KEY,
    'Payment card number. Stored through the secret manager at daemon scope; entering it here or via /payments card never shows the typed characters in plaintext.',
  );
}

export function buildPaymentsCardExpiryEntry(configManager: PaymentsConfigReader): PaymentsSettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
    'Payment card expiry (MM/YY). Stored through the secret manager at daemon scope, same handling as the card number.',
  );
}

export function buildPaymentsCardCvvEntry(configManager: PaymentsConfigReader): PaymentsSettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_CVV_CONFIG_KEY,
    'Payment card CVV. Stored through the secret manager at daemon scope: never logged, never rendered, never shown mid-edit, excluded from every export and diagnostic dump.',
  );
}

export function buildPaymentsCardCardholderNameEntry(configManager: PaymentsConfigReader): PaymentsSettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
    'Name on the payment card. Stored through the secret manager at daemon scope, same handling as the card number.',
  );
}

/** All payments synthetic entries (the four card-material fields), in render order. */
export function buildPaymentsSyntheticEntries(configManager: PaymentsConfigReader): PaymentsSettingEntry[] {
  return [
    buildPaymentsCardNumberEntry(configManager),
    buildPaymentsCardExpiryEntry(configManager),
    buildPaymentsCardCvvEntry(configManager),
    buildPaymentsCardCardholderNameEntry(configManager),
  ];
}

/** Refresh one payments synthetic entry's currentValue/isDefault in place. */
export function refreshPaymentsSyntheticEntry(
  entry: { setting: { readonly key: string }; currentValue: unknown; isDefault: boolean },
  configManager: PaymentsConfigReader,
): void {
  const currentValue = readStringField(configManager, entry.setting.key as ConfigKey);
  entry.currentValue = currentValue;
  entry.isDefault = currentValue === '';
}

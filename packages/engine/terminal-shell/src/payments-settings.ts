/** Payment settings rows shared by both terminal apps. */
import type { ConfigManager, ConfigKey, ConfigSetting } from '@goodvibes-jev/engine/platform/platform/config';
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
  locked: boolean;
  lockReason: string;
}
/**
 * The one payments row that is not a schema setting: where the cards are. Cards
 * live in the daemon's card store, added and removed with `/payments card` (or
 * the web UI); Settings shows the way there and accepts no card material.
 */
export const PAYMENTS_CARDS_ROW_KEY = 'payments.cardsOnFile' as ConfigKey;
export function buildPaymentsCardsRow(): PaymentsSettingEntry {
  return {
    setting: {
      key: PAYMENTS_CARDS_ROW_KEY,
      type: 'string',
      default: '',
      description: 'Cards purchases can use. Add, list and remove them with /payments card (or Payments in the web UI); Settings never takes a card number.',
    },
    currentValue: 'managed with /payments card',
    isDefault: true,
    locked: true,
    lockReason: 'Cards are managed with /payments card or the web UI.',
  };
}

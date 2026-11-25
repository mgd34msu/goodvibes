/** Payment settings rows shared by both terminal apps. */
import type { ConfigManager, ConfigKey, ConfigSetting } from '@goodvibes/engine/platform/platform/config';
export {
  PAYMENTS_CVV_HANDLING_CONFIG_KEY,
  PAYMENTS_ADDRESS_FIELD_SUFFIXES,
  paymentsAddressConfigKey,
  paymentsAddressConfigKeys,
} from '@goodvibes/engine/platform/platform/config';
export type { PaymentsAddressKind } from '@goodvibes/engine/platform/platform/config';
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
 * live in the daemon's card store, added and removed in the Money place (or
 * the web UI); Settings shows the way there and accepts no card material.
 */
export const PAYMENTS_CARDS_ROW_KEY = 'payments.cardsOnFile' as ConfigKey;
export function buildPaymentsCardsRow(): PaymentsSettingEntry {
  return {
    setting: {
      key: PAYMENTS_CARDS_ROW_KEY,
      label: 'Cards on file',
      type: 'string',
      default: '',
      description: 'Cards purchases can use. Enter closes Settings and opens Money on its Cards tab, which lists the cards on the daemon and adds or removes one. Settings never takes a card number.',
    },
    currentValue: 'Enter: open Money, Cards',
    isDefault: true,
    locked: true,
    lockReason: 'Cards are managed in the Money place or the web UI.',
  };
}

/** What the cards row needs from the command context: the program's way to open a place. */
export interface PaymentsCardsRowContext {
  readonly print: (message: string) => void;
  readonly openPlace?: ((id: string, start?: { readonly list?: string | undefined }) => void) | undefined;
}

/**
 * Enter on the cards row, after Settings has closed: Money opens on its Cards tab (the cards the daemon holds, read
 * by themselves; `n` adds one in its hidden form, `x` removes one).
 */
export async function openPaymentsCardsFromSettings(context: PaymentsCardsRowContext): Promise<void> {
  if (!context.openPlace) {
    context.print('Money, Cards, in the menu of places, lists your cards and adds one.');
    return;
  }
  context.openPlace('money', { list: 'cards' });
}

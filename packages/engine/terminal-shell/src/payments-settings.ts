/** Payment settings rows shared by both terminal apps. */
import type { ConfigManager, ConfigKey, ConfigSetting } from '@goodvibes-jev/engine/platform/platform/config';
export {
  PAYMENTS_CVV_HANDLING_CONFIG_KEY,
  PAYMENTS_ADDRESS_FIELD_SUFFIXES,
  paymentsAddressConfigKey,
  paymentsAddressConfigKeys,
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
 * live in the daemon's card store, added and removed with `/payments` (or
 * the web UI); Settings shows the way there and accepts no card material.
 */
export const PAYMENTS_CARDS_ROW_KEY = 'payments.cardsOnFile' as ConfigKey;
export function buildPaymentsCardsRow(): PaymentsSettingEntry {
  return {
    setting: {
      key: PAYMENTS_CARDS_ROW_KEY,
      type: 'string',
      default: '',
      description: 'Cards purchases can use. Enter closes Settings, lists the cards on the daemon, and starts "Add a card" (Esc stops it); /payments remove-card deletes one. Settings never takes a card number.',
    },
    currentValue: 'Enter: list cards and add one',
    isDefault: true,
    locked: true,
    lockReason: 'Cards are managed with /payments or the web UI.',
  };
}

/** What the cards row needs from the command context: the command runner the composer uses. */
export interface PaymentsCardsRowContext {
  readonly print: (message: string) => void;
  readonly executeCommand?: ((name: string, args: string[]) => Promise<boolean>) | undefined;
}

/**
 * Enter on the cards row, after Settings has closed: list the cards the daemon
 * holds (with their count, from `payments.cards.list`), then start the masked
 * card entry, exactly as `/payments cards` and `/payments add-card` do.
 */
export async function openPaymentsCardsFromSettings(context: PaymentsCardsRowContext): Promise<void> {
  if (!context.executeCommand) {
    context.print('Run /payments cards to list your cards and /payments add-card to add one.');
    return;
  }
  await context.executeCommand('payments', ['cards']);
  await context.executeCommand('payments', ['add-card']);
}

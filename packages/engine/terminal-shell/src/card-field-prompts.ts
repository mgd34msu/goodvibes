import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
} from './payments-settings.js';
import type { ConcealedInputRequest } from './concealed-input.js';
export interface CardField {
  readonly key: ConfigKey;
  readonly label: string;
  readonly placeholder: string;
}
export const CARD_SECRET_FIELDS: readonly CardField[] = [
  { key: PAYMENTS_CARD_NUMBER_CONFIG_KEY, label: 'Card number', placeholder: '4242424242424242' },
  { key: PAYMENTS_CARD_EXPIRY_CONFIG_KEY, label: 'Expiry (MM/YY)', placeholder: '12/34' },
  { key: PAYMENTS_CARD_CVV_CONFIG_KEY, label: 'CVV', placeholder: '123' },
  { key: PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY, label: 'Cardholder name', placeholder: 'as printed on the card' },
];
export interface CardPromptContext {
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
}
/** Plaintext exists only in the owned concealed submission and the supplied secret writer. */
export function createCardFieldPrompter<Context extends CardPromptContext>(
  write: (context: Context, field: CardField, value: string) => Promise<unknown>,
  presentation: {
    readonly completed: string;
    readonly prompt: (field: CardField) => string;
  },
) {
  function promptCardFields(ctx: Context, fields: readonly CardField[], index: number): void {
    if (index >= fields.length) {
      ctx.print(presentation.completed);
      ctx.renderRequest();
      return;
    }
    const field = fields[index]!;
    if (!ctx.beginConcealedInput) {
      ctx.print('[payments] Concealed input is unavailable on this surface; card entry requires it and cannot fall back to plaintext.');
      return;
    }
    ctx.print(presentation.prompt(field));
    let cancelled = false;
    let finished = false;
    let submitted = false;
    ctx.beginConcealedInput({
      label: field.label,
      onSubmit: async (value) => {
        if (submitted || cancelled) return;
        submitted = true;
        if (value.length === 0) {
          finished = true;
          ctx.print(`[payments] ${field.label} left unset.`);
          promptCardFields(ctx, fields, index + 1);
          return;
        }
        try {
          await write(ctx, field, value);
          if (cancelled) return;
          ctx.print(`[payments] ${field.label} stored securely (hidden).`);
        } catch {
          if (cancelled) return;
          // Store failures may quote the input. Only the field label is safe.
          ctx.print(`[payments] Failed to store ${field.label}. Try again.`);
          finished = true;
          promptCardFields(ctx, fields, index);
          return;
        }
        finished = true;
        promptCardFields(ctx, fields, index + 1);
      },
      onCancel: () => {
        if (finished || cancelled) return;
        cancelled = true;
        ctx.print('[payments] Stopped. Re-run /payments card to finish the remaining fields.');
      },
    });
  }
  return promptCardFields;
}

import { mayOfferCardEntryFlow, describeCardEntryRefusal } from '@goodvibes-jev/engine/sdk/platform/payments';
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

/** Never ask for card material until the deterministic entry-surface check passes. */
export function createPaymentCardCommands<Context extends CardPromptContext>(policy: {
  readonly surface: string;
  readonly announcement: string;
  readonly promptFields: (context: Context, fields: readonly CardField[], index: number) => void;
  readonly status: (context: Context) => string[];
  readonly address?: ((context: Context, kind: 'billing' | 'shipping') => void) | undefined;
  readonly description: string;
  readonly usage: string;
  readonly argsHint: string;
}) {
  function startCardEntryFlow(context: Context, surface: string = policy.surface): void {
    if (!mayOfferCardEntryFlow(surface)) {
      context.print(describeCardEntryRefusal(surface));
      return;
    }
    if (!context.beginConcealedInput) {
      context.print('[payments] Concealed input is unavailable on this surface.');
      return;
    }
    context.print(policy.announcement);
    policy.promptFields(context, CARD_SECRET_FIELDS, 0);
  }
  function runPaymentsCommand(args: readonly string[], context: Context): void {
    const sub = (args[0] ?? '').toLowerCase();
    if (!sub || sub === 'status') {
      context.print(policy.status(context).join('\n'));
      return;
    }
    if (sub === 'card') {
      startCardEntryFlow(context);
      return;
    }
    if (sub === 'address' && policy.address) {
      const kind = (args[1] ?? '').toLowerCase();
      if (kind !== 'billing' && kind !== 'shipping') {
        context.print('Usage: /payments address <billing|shipping>');
        return;
      }
      policy.address(context, kind);
      return;
    }
    context.print('Usage: /payments [' + (policy.address ? 'card|address <billing|shipping>|status' : 'card|status') + ']');
  }
  function registerPaymentCardCommands(registry: Pick<import('./command-registry.js').TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'payments',
      description: policy.description,
      usage: policy.usage,
      argsHint: policy.argsHint,
      handler: (args, context) => runPaymentsCommand(args, context),
    });
  }
  return { startCardEntryFlow, runPaymentsCommand, registerPaymentCardCommands };
}

export function cardFieldConfigured(
  manager: Pick<import('@goodvibes-jev/engine/sdk/platform/config').ConfigManager, 'get'>,
  field: CardField,
): boolean {
  const value: unknown = manager.get(field.key);
  return typeof value === 'string' && value.trim().length > 0;
}

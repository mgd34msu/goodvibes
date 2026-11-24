import type { OperatorApiClient } from '@goodvibes/engine/operator-client';
import type { ConcealedInputRequest } from './concealed-input.js';
import { isPairedOperatorPrincipal } from './native/native-paired-principal.js';
import { RetainedOperatorConnection } from './retained-operator-connection.js';
import type { PaymentWindowCommandPolicy } from './payment-window-command.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import { classifyFailure } from '@goodvibes/engine/errors';

export type CardFieldId = 'label' | 'kind' | 'number' | 'expiry' | 'cvv' | 'cardholderName';
export interface CardField {
  readonly key: CardFieldId;
  readonly label: string;
  readonly placeholder: string;
}
/** Prompt order. Every answer goes through the concealed prompt, the label and kind included, so one rule covers the whole card. */
export const CARD_ENTRY_FIELDS: readonly CardField[] = [
  { key: 'label', label: 'Card label', placeholder: 'groceries virtual card' },
  { key: 'kind', label: 'Card kind (virtual or real; blank for virtual)', placeholder: 'virtual' },
  { key: 'number', label: 'Card number', placeholder: '4242424242424242' },
  { key: 'expiry', label: 'Expiry (MM/YY)', placeholder: '12/34' },
  { key: 'cvv', label: 'CVV', placeholder: '123' },
  { key: 'cardholderName', label: 'Cardholder name', placeholder: 'as printed on the card' },
];

/** The `payments.cards.create` input. */
export interface CardCreateInput {
  readonly label: string;
  readonly kind: 'virtual' | 'real';
  readonly number: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly cvv: string;
  readonly cardholderName: string;
  readonly issuerCapMinorUnits: null;
}

/** What the host returns for a stored card: metadata only, never the number, expiry, CVV or name. */
export interface CardSummary {
  readonly id: string;
  readonly label: string;
  readonly brand: string;
  readonly last4: string;
  readonly kind: 'virtual' | 'real';
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly issuerCapMinorUnits: number | null;
  readonly materialComplete: boolean;
}

/**
 * One field's problem in words. It never contains the value, because a rejected card number is still a card number.
 * Checked when the field is typed, so a wrong field is asked again on the spot instead of after all six answers.
 */
function cardFieldProblem(key: CardFieldId, raw: string, now: Date = new Date()): string | null {
  const text = raw.trim();
  switch (key) {
    case 'label': return text.length === 0 ? 'A label is required so you can tell cards apart.' : null;
    case 'kind': return text.length === 0 || /^(virtual|real)$/i.test(text) ? null : "The kind is 'virtual' or 'real'.";
    case 'number': {
      const digits = text.replace(/[\s-]/g, '');
      if (!/^\d{13,19}$/.test(digits)) return 'A card number is 13 to 19 digits.';
      return passesLuhn(digits) ? null : 'That card number fails the check every card number passes, so a digit is wrong or two are swapped.';
    }
    case 'expiry': {
      const expiry = parseCardExpiry(text);
      if (expiry === null) return 'Expiry must look like MM/YY, for example 09/29.';
      // A card works through the last day of its expiry month.
      const expired = expiry.year < now.getFullYear() || (expiry.year === now.getFullYear() && expiry.month < now.getMonth() + 1);
      return expired ? 'That expiry date has already passed. Enter the date on the current card.' : null;
    }
    case 'cvv': return /^\d{3,4}$/.test(text) ? null : 'The security code is 3 or 4 digits.';
    case 'cardholderName': return text.length === 0 ? 'Enter the name as printed on the card.' : null;
  }
}

/** The card-number checksum (ISO/IEC 7812): every issued card number passes it. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** "MM/YY" or "MM/YYYY"; a two-digit year means 20YY. */
export function parseCardExpiry(text: string): { month: number; year: number } | null {
  const match = /^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/.exec(text);
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  const year = match[2]!.length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  return { month, year };
}

/** Turn the six answers into the host input. Returns the first problem instead (never the value) when one is invalid or missing. */
export function buildCardCreateInput(values: Readonly<Partial<Record<CardFieldId, string>>>): CardCreateInput | { readonly problem: string; readonly field: CardFieldId } {
  for (const field of CARD_ENTRY_FIELDS) {
    const problem = cardFieldProblem(field.key, values[field.key] ?? '');
    if (problem !== null) return { problem, field: field.key };
  }
  const expiry = parseCardExpiry(values.expiry ?? '');
  if (expiry === null) return { problem: 'Expiry must look like MM/YY, for example 09/29.', field: 'expiry' };
  return {
    label: (values.label ?? '').trim(),
    kind: (values.kind ?? '').trim().toLowerCase() === 'real' ? 'real' : 'virtual',
    number: (values.number ?? '').replace(/[\s-]/g, ''),
    expiryMonth: expiry.month,
    expiryYear: expiry.year,
    cvv: (values.cvv ?? '').trim(),
    cardholderName: (values.cardholderName ?? '').trim(),
    issuerCapMinorUnits: null,
  };
}

export interface CardPromptContext {
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
  /** True when a model, not the person at the keyboard, ran the command. */
  readonly invokedByModel?: boolean | undefined;
}

/**
 * Ask for every card field through concealed input, then send the whole card
 * to the host in one request. The answers live only in this flow's local
 * object: nothing is written to config, the transcript or a log, and Esc
 * before the last answer discards them.
 */
export function createCardEntryPrompter<Context extends CardPromptContext>(
  create: (context: Context, card: CardCreateInput) => Promise<CardSummary>,
  presentation: {
    readonly prompt: (field: CardField) => string;
    readonly stored: (card: CardSummary) => string;
  },
) {
  function ask(ctx: Context, fields: readonly CardField[], index: number, values: Partial<Record<CardFieldId, string>>): void {
    const field = fields[index];
    if (!field) return;
    if (!ctx.beginConcealedInput) {
      ctx.print('[payments] Concealed input is unavailable on this surface; card entry requires it and cannot fall back to plaintext.');
      return;
    }
    ctx.print(presentation.prompt(field));
    let cancelled = false;
    let finished = false;
    let submitted = false;
    const last = index === fields.length - 1;
    ctx.beginConcealedInput({
      label: field.label,
      onSubmit: async (value) => {
        if (submitted || cancelled) return;
        submitted = true;
        const problem = cardFieldProblem(field.key, value);
        if (problem !== null) {
          finished = true;
          ctx.print(`[payments] ${problem} Nothing has been sent.`);
          ask(ctx, fields, index, values);
          return;
        }
        values[field.key] = value;
        if (!last) {
          finished = true;
          ask(ctx, fields, index + 1, values);
          return;
        }
        const card = buildCardCreateInput(values);
        for (const key of Object.keys(values) as CardFieldId[]) delete values[key];
        if ('problem' in card) {
          finished = true;
          ctx.print(`[payments] ${card.problem} Nothing has been sent.`);
          return;
        }
        try {
          const stored = await create(ctx, card);
          if (cancelled) return;
          ctx.print(presentation.stored(stored));
        } catch (error: unknown) {
          if (cancelled) return;
          // The message is chosen by the host client, never the host's own text, which could quote the request.
          // A CardHostError is raised before the request leaves this process.
          ctx.print(`[payments] ${describeCardFailure(error, 'add')}${error instanceof CardHostError ? ' Nothing was sent.' : ''}`);
        }
        finished = true;
        ctx.renderRequest();
      },
      onCancel: () => {
        if (finished || cancelled) return;
        cancelled = true;
        ctx.print(
          submitted
            ? '[payments] Stopped. The card was already being sent and may have been stored; /payments cards shows the cards the host has.'
            : '[payments] Stopped. Nothing was sent and the answers so far were discarded. Choose "Add a card" in /payments to start again.',
        );
      },
    });
  }
  return function promptCardFields(ctx: Context, fields: readonly CardField[], index: number): void {
    if (index === 0) ask(ctx, fields, 0, {});
  };
}

/**
 * Fixed text for a failed host call, chosen by the status the daemon answered
 * with. The daemon's own message is never passed through: a refusal can quote
 * the request, and the request held the card.
 */
export function describeCardFailure(error: unknown, attempt: 'start' | 'add' | 'remove' = 'add'): string {
  if (error instanceof CardHostError) return error.message;
  const status = failureStatus(error);
  const category = classifyFailure(error)?.category;
  if (attempt === 'start') {
    // The card list is read before any field is asked, so a daemon that cannot take the card is found first.
    const why = category === 'authentication' || category === 'authorization'
      ? 'it refused this terminal\'s credential for payments; check the selected host, its pairing and the payments scope'
      : status === 409 ? 'its card store cannot be read; the daemon\'s log names the file to repair'
        : status !== undefined ? 'it could not list its cards; the daemon\'s log has the reason'
          : 'it did not answer';
    return `Card entry did not start: the selected daemon could not take a card (${why}). Nothing was asked or sent; run /payments add-card again once it can.`;
  }
  const unchanged = attempt === 'add' ? 'Nothing was saved' : 'Nothing was removed';
  const rerun = attempt === 'add' ? '/payments add-card' : '/payments remove-card <card>';
  if (status === 400 || status === 422) {
    return attempt === 'add'
      ? `The daemon rejected a card field as invalid (it needs a number with enough digits, an expiry month from 1 to 12 with a four-digit year, and a 3 or 4 digit security code). ${unchanged}; run ${rerun} to enter the card again.`
      : `The daemon rejected the card id. ${unchanged}; /payments cards lists each card.`;
  }
  if (category === 'authentication' || category === 'authorization') {
    return `The selected daemon refused this terminal's credential for payments. ${unchanged}. Check the selected host, its pairing and the payments scope, then run ${rerun} again.`;
  }
  if (status === 409) {
    return `The daemon's card store cannot be read. ${unchanged}. The daemon's log names the file to repair; then run ${rerun} again.`;
  }
  if (status !== undefined && status >= 500) {
    return `The daemon could not ${attempt === 'add' ? 'store' : 'remove'} the card. ${unchanged}. Run ${rerun} again; if it fails again, the daemon's log has the reason.`;
  }
  return `The daemon did not answer, so it is not known whether the card was ${attempt === 'add' ? 'stored' : 'removed'}. Run /payments cards to see which cards it holds before trying again.`;
}

function failureStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const own = (error as { readonly status?: unknown }).status;
  if (typeof own === 'number') return own;
  const body = (error as { readonly body?: unknown }).body;
  const nested = body && typeof body === 'object' ? (body as { readonly status?: unknown }).status : undefined;
  return typeof nested === 'number' ? nested : undefined;
}

/** A refusal whose text is safe to print: written here, never copied from the host's response. */
export class CardHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardHostError';
  }
}

/** Host selection comes from the product, the same policy the purchase-window command uses. */
export type PaymentCardHostPolicy<Context> = Omit<PaymentWindowCommandPolicy<Context>, 'isOwner'>;

/** Add, list and remove cards on the selected paired daemon. A fresh connection per call; none is kept. */
export function createPaymentCardHost<Context>(policy: PaymentCardHostPolicy<Context>) {
  async function withHost<T>(
    context: Context,
    scope: 'read:payments' | 'write:payments',
    work: (operator: OperatorApiClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lifetime = new AbortController();
    let connection: RetainedOperatorConnection;
    try {
      connection = new RetainedOperatorConnection({
        owner: () => policy.owner(context), home: () => policy.home(context),
        read: observation => policy.read(context, observation), files: policy.files,
        environment: policy.environment, fetchImpl: policy.fetchImpl, signal: lifetime.signal,
      });
    } catch {
      throw new CardHostError('No paired daemon is selected, or its credential changed. Check the selected host and pairing, then run the command again.');
    }
    try {
      const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
      if (!isPairedOperatorPrincipal(auth, [scope], connection.expectedPrincipalId)) {
        throw new CardHostError(`The selected daemon does not give this terminal a paired administrative credential with ${scope}.`);
      }
      return await connection.run(work);
    } finally {
      lifetime.abort();
      await connection.close();
    }
  }
  return {
    async create(context: Context, card: CardCreateInput): Promise<CardSummary> {
      const result = await withHost(context, 'write:payments', (operator, signal) => operator.invoke('payments.cards.create', card, { signal }));
      return result.card;
    },
    async list(context: Context): Promise<{ readonly cards: readonly CardSummary[]; readonly defaultCardId: string }> {
      const result = await withHost(context, 'read:payments', (operator, signal) => operator.invoke('payments.cards.list', {}, { signal }));
      return { cards: result.cards, defaultCardId: result.defaultCardId };
    },
    async remove(context: Context, id: string): Promise<{ readonly deleted: boolean }> {
      const result = await withHost(context, 'write:payments', (operator, signal) => operator.invoke('payments.cards.delete', { id }, { signal }));
      return { deleted: result.deleted };
    },
  };
}

/** One card in words: metadata the host returned, with terminal control sequences removed. */
export function describeCard(card: CardSummary): string {
  const month = String(card.expiryMonth).padStart(2, '0');
  const cap = card.issuerCapMinorUnits === null ? '' : `, issuer cap ${card.issuerCapMinorUnits} minor units`;
  const note = card.materialComplete ? '' : ' (incomplete: a stored field is missing, add the card again)';
  return stripDangerousAnsi(`${card.label} - ${card.kind} ${card.brand} ending ${card.last4}, expires ${month}/${card.expiryYear}${cap}${note}`);
}

/** Status lines for the cards the host holds: metadata only, nothing that could rebuild a card. */
export function renderCardList(list: { readonly cards: readonly CardSummary[]; readonly defaultCardId: string }): string[] {
  const lines = [`Payment cards on the selected daemon: ${list.cards.length}`];
  if (list.cards.length === 0) lines.push('  none. Add one with /payments add-card.');
  for (const card of list.cards) lines.push(`  ${card.id === list.defaultCardId ? '*' : ' '} ${describeCard(card)} [id ${stripDangerousAnsi(card.id)}]`);
  lines.push('');
  lines.push('/payments add-card adds a card (each field hidden, sent to the daemon in one request).');
  if (list.cards.length > 0) lines.push('/payments remove-card deletes one from the daemon for good; /payments add-card stores it again.');
  return lines;
}

/**
 * money-parsing.ts, turning what a checkout page SAYS into an integer we own.
 *
 * Every amount on a checkout page is a string chosen by whoever runs that page.
 * It reaches us as text and it must never leave this module as text: the rule
 * for the whole capability is that our own code parses merchant strings into
 * integer minor units, and every number the owner is later shown is re-rendered
 * from those integers by `formatMinorUnits`. A merchant's own "$1,234.56" never
 * passes through to a notice, a decision, or a ledger row.
 *
 * ── Refusing beats guessing ───────────────────────────────────────────────
 *
 * `parseMinorUnits` returns null for anything it cannot read one way. That is
 * the entire safety property here, and it is why the grammar below is a short
 * list of exact shapes rather than a lenient scrubber:
 *
 *   - A scrubber that strips every non-digit turns "1.234,56" into 123456 and
 *     "1,234.56" into 123456 as well. Those are the same number by luck, and
 *     "1.234" versus "1,234" is where the luck runs out, a factor of a
 *     thousand, silently, on the number a budget is checked against.
 *   - A parser that falls back to `Number(...)` accepts "1e6", "0x10",
 *     "Infinity" and " 12 " and produces a value for each. A page that wants to
 *     be charged more than the budget allows would only have to find whichever
 *     of those the budget check rounds in its favour.
 *
 * So: three unambiguous shapes, anything else is a refusal, and a refusal stops
 * the purchase rather than defaulting to zero. A zero default is worse than a
 * crash, because a tax line that fails to parse as 0 makes an over-budget order
 * look affordable.
 *
 * ── Ambiguity is decided by the grammar, not by locale guessing ──────────
 *
 * A thousands group is always exactly three digits, and a fractional part is
 * never more than the currency's exponent. Those two facts separate every real
 * case without knowing the page's locale:
 *
 *   "1,234"    → 3 digits after the separator, too many to be a 2-exponent
 *                fraction, so it is a thousands group: 1234 major units.
 *   "1.234"    → same reasoning with the separators swapped: 1234 major units.
 *   "1,23"     → 2 digits, too few to be a thousands group: 1.23.
 *   "1,23,456" → matches nothing. Refused rather than salvaged.
 *
 * Three-decimal currencies (KWD, BHD, OMR, ...) are where those two facts
 * collide: "0.750" and "12.500" are how those prices are printed, and they have
 * the thousands-group shape. The page's own amounts decide first
 * (`pageDecimalMark`): "0.750", "1,234.500" or "1234.500" show the mark, and
 * every split on that page is read by it. When nothing shows it, a dot split
 * is a fraction, the reading the owner's own maximum gets and how these
 * currencies are written wherever a dot is the decimal mark; a comma split is
 * refused, because "KD 1,234" (whole dinars, grouped) and "12,500 DT" (a
 * fraction) are both written that way, and reading the first as the second
 * would put a thousandth of the price against the budget. A page that shows no
 * mark while also writing bare whole numbers beside a split is refused too.
 */
import type { CurrencyCode, MinorUnits } from './types.js';

/** Currencies whose minor unit is a thousandth rather than a hundredth. */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
/** Currencies with no minor unit at all. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF', 'XPF']);

/**
 * How many minor units make one major unit, as a power of ten.
 *
 * Exported because the extractor, the parser and the renderer must agree; a
 * second copy of this table is a bug waiting for the first three-decimal
 * currency to arrive.
 */
export function minorUnitExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

/**
 * The largest amount that may come off a page, in minor units.
 *
 * A hard ceiling well inside `Number.MAX_SAFE_INTEGER`, so arithmetic on parsed
 * amounts stays exact no matter what a page claims. A page asking for more than
 * this is refused at parse time rather than reaching a budget comparison that
 * would have handled it correctly anyway, the budget is the second line, and a
 * value that cannot be added without losing precision should never reach it.
 */
export const MAX_PARSEABLE_MINOR_UNITS = 1_000_000_000_000;

/** Exact owner limit in the configured currency, rather than merchant prose.
 * Accept decimal major units only: no signs, grouping, currency conversion,
 * ranges or text to strip. In particular, "10 20" must never become 1020. */
export function parseRequestedMaximum(raw: string, currency: CurrencyCode): MinorUnits | null {
  const exponent = minorUnitExponent(currency);
  const grammar = exponent === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${exponent}})?$`);
  if (typeof raw !== 'string' || !grammar.test(raw.trim())) return null;
  // Do not delegate to the merchant parser's grouping rules: in KWD, "1.234"
  // here is exactly 1234 minor units, never a grouped 1234 major units.
  const [majorText, fraction = ''] = raw.trim().split('.');
  const major = Number(majorText);
  if (!Number.isSafeInteger(major)) return null;
  const total = major * 10 ** exponent + Number(fraction.padEnd(exponent, '0'));
  return Number.isSafeInteger(total) && total <= MAX_PARSEABLE_MINOR_UNITS ? total : null;
}

/** Characters a page may put around a number that carry no numeric meaning. */
const CURRENCY_ORNAMENT = /[\p{Sc}\s   ]/gu;

/** The character a page writes between whole units and the fraction. */
export type DecimalMark = '.' | ',';

/** One separator, one to three digits before it and exactly three after:
 *  a fraction or one thousands group, depending on the page. */
const THREE_DIGIT_SPLIT = /^\d{1,3}[.,]\d{3}$/;

/**
 * The one numeric run of an amount string, with currency ornament removed, or
 * null when the text is empty, negative, holds more than one number, or says
 * something besides the number.
 */
function amountNumeral(raw: string, currency: string): string | null {
  // Strip currency symbols, the ISO code itself, and every flavour of space.
  // Nothing here removes a digit or a separator, so the grammar still sees the
  // full layout the page chose.
  let text = raw.replace(CURRENCY_ORNAMENT, '');
  text = text.replace(new RegExp(currency, 'gi'), '');
  text = text.trim();
  if (text.length === 0) return null;

  // A negative amount, however it is spelled, is not something we act on.
  if (/^[-−(]/.test(text) || text.endsWith(')') || text.includes('-')) return null;

  // Exactly one numeric run. Two numbers in one string means the selector
  // picked up a range, a strikethrough price beside a sale price, or a whole
  // summary block, none of which we may choose between.
  const runs = text.match(/\d[\d.,]*/g);
  if (runs === null || runs.length !== 1) return null;
  const [number] = runs;
  if (number === undefined) return null;

  // Anything outside the number must be ornamental. A letter left over means
  // the string said something we did not understand ("12.00/mo", "from 12.00").
  const remainder = text.replace(number, '');
  if (/[\p{L}\p{N}]/u.test(remainder)) return null;
  return number;
}

/**
 * The decimal mark one numeral shows by its own layout, or undefined when it
 * shows none ("750", or a three-digit split such as "1.234").
 */
function revealedDecimalMark(number: string): DecimalMark | undefined {
  const dots = number.split('.').length - 1;
  const commas = number.split(',').length - 1;
  if (dots > 0 && commas > 0) return number.lastIndexOf('.') > number.lastIndexOf(',') ? '.' : ',';
  // The same mark twice can only be grouping, so the other one is the decimal.
  if (dots > 1) return ',';
  if (commas > 1) return '.';
  if (dots + commas === 0) return undefined;
  const separator: DecimalMark = dots === 1 ? '.' : ',';
  const before = number.indexOf(separator), after = number.length - before - 1;
  // A thousands group is exactly three digits, follows at most three, and
  // never follows a lone zero.
  if (after !== 3 || before > 3 || number.startsWith(`0${separator}`)) return separator;
  return undefined;
}

/**
 * How a checkout page writes its amounts, decided from the amounts themselves.
 *
 * Only three-decimal currencies need this; for every other currency the
 * grammar in `parseMinorUnits` decides alone and the answer is `{ ok: true }`.
 * Refused (`ok: false`) when two amounts on the page show different decimal
 * marks, or when nothing shows one and the page writes either a comma split
 * ("1,234": whole dinars grouped, or a fraction where a comma is the decimal
 * mark) or both three-digit splits and bare whole numbers ("1.234" + "5" adds
 * up to 6.234 or to 1239), since the page gives no way to tell which.
 */
export function pageDecimalMark(
  amounts: readonly string[],
  currency: CurrencyCode | string,
): { readonly ok: true; readonly mark?: DecimalMark } | { readonly ok: false; readonly example: string } {
  if (minorUnitExponent(currency) !== 3) return { ok: true };
  let mark: DecimalMark | undefined;
  let split: string | undefined;
  let commaSplit: string | undefined;
  let whole = false;
  for (const raw of amounts) {
    // Discount lines may carry a sign; the layout of the digits is what counts.
    const unsigned = unsignedAmountText(raw);
    const number = unsigned === null ? null : amountNumeral(unsigned, currency);
    if (number === null) continue;
    const shown = revealedDecimalMark(number);
    if (shown !== undefined) {
      if (mark !== undefined && mark !== shown) return { ok: false, example: number };
      mark = shown;
    } else if (THREE_DIGIT_SPLIT.test(number)) {
      split ??= number;
      if (number.includes(',')) commaSplit ??= number;
    } else if (/^\d+$/.test(number) && Number(number) !== 0) whole = true;
  }
  if (mark !== undefined) return { ok: true, mark };
  if (commaSplit !== undefined) return { ok: false, example: commaSplit };
  if (split !== undefined && whole) return { ok: false, example: split };
  return { ok: true };
}

/**
 * Read one amount off a page, or refuse.
 *
 * Returns null, never a fallback, when the text is empty, holds no number,
 * holds more than one number, is negative, uses a separator layout that could
 * mean two different values, or exceeds the parse ceiling.
 *
 * A leading minus is refused rather than negated: a negative amount where a
 * charge belongs is a discount or a credit, and treating one as a normal amount
 * that happens to reduce the total is how a page talks a budget check into
 * passing. Discounts have their own lines, read by `parseDiscountMinorUnits`.
 *
 * `decimalMark` is the page's mark from `pageDecimalMark`. In a three-decimal
 * currency it decides a three-digit split, and an amount that shows the other
 * mark is refused; without it a dot split is a fraction, the reading
 * `parseRequestedMaximum` gives the owner's own figure, and a comma split is
 * refused as a whole-or-fraction guess.
 */
export function parseMinorUnits(
  raw: string,
  currency: CurrencyCode | string,
  decimalMark?: DecimalMark,
): MinorUnits | null {
  if (typeof raw !== 'string') return null;
  const exponent = minorUnitExponent(currency);
  const number = amountNumeral(raw, currency);
  if (number === null) return null;

  if (exponent === 3) {
    const shown = revealedDecimalMark(number);
    if (decimalMark !== undefined && shown !== undefined && shown !== decimalMark) return null;
    if (THREE_DIGIT_SPLIT.test(number)) {
      const separator = number.charAt(number.length - 4);
      if (decimalMark === undefined && separator === ',') return null;
      const [major = '', minor = ''] = number.split(separator);
      const grouped = decimalMark !== undefined && decimalMark !== separator;
      return exactMinorUnits(grouped ? `${major}${minor}` : major, grouped ? '' : minor, exponent);
    }
  }

  const fraction = exponent === 0 ? '' : `{1,${String(exponent)}}`;

  // Shape 1: comma thousands, dot fraction.  1,234.56
  const usStyle = new RegExp(`^\\d{1,3}(?:,\\d{3})+(?:\\.\\d${fraction})?$`);
  // Shape 2: dot thousands, comma fraction.  1.234,56
  const euStyle = new RegExp(`^\\d{1,3}(?:\\.\\d{3})+(?:,\\d${fraction})?$`);
  // Shape 3: no thousands separator at all.  1234.56  or  1234,56  or  1234
  const plain = exponent === 0
    ? /^\d+$/
    : new RegExp(`^\\d+(?:[.,]\\d${fraction})?$`);

  let majorText: string;
  let minorText: string;

  if (usStyle.test(number)) {
    const dot = number.indexOf('.');
    majorText = (dot === -1 ? number : number.slice(0, dot)).replace(/,/g, '');
    minorText = dot === -1 ? '' : number.slice(dot + 1);
  } else if (euStyle.test(number)) {
    const comma = number.indexOf(',');
    majorText = (comma === -1 ? number : number.slice(0, comma)).replace(/\./g, '');
    minorText = comma === -1 ? '' : number.slice(comma + 1);
  } else if (plain.test(number)) {
    const separator = number.search(/[.,]/);
    majorText = separator === -1 ? number : number.slice(0, separator);
    minorText = separator === -1 ? '' : number.slice(separator + 1);
  } else {
    return null;
  }
  return exactMinorUnits(majorText, minorText, exponent);
}

function exactMinorUnits(majorText: string, minorText: string, exponent: number): MinorUnits | null {
  if (!/^\d+$/.test(majorText)) return null;
  if (minorText !== '' && !/^\d+$/.test(minorText)) return null;
  if (minorText.length > exponent) return null;

  const major = Number(majorText);
  if (!Number.isSafeInteger(major)) return null;
  const minor = minorText === '' ? 0 : Number(minorText.padEnd(exponent, '0'));
  if (!Number.isSafeInteger(minor)) return null;

  const total = major * 10 ** exponent + minor;
  if (!Number.isSafeInteger(total)) return null;
  if (total > MAX_PARSEABLE_MINOR_UNITS) return null;
  return total;
}

/**
 * Read one discount, credit or promotion line off a page as the amount it
 * takes off, or refuse.
 *
 * Pages write a reduction as "-5.00", "−$5.00", "($5.00)" or a bare "5.00" on
 * a line labelled as a discount; all four mean five off. The sign, when there
 * is one, is taken off here and the rest goes through `parseMinorUnits`'
 * grammar unchanged, so the same ambiguity rules apply. The result is the
 * magnitude: a discount line can only lower what is charged, never raise it.
 */
export function parseDiscountMinorUnits(
  raw: string,
  currency: CurrencyCode | string,
  decimalMark?: DecimalMark,
): MinorUnits | null {
  const text = unsignedAmountText(raw);
  return text === null ? null : parseMinorUnits(text, currency, decimalMark);
}

/** A reduction's text with its one sign or its parentheses taken off, or null. */
function unsignedAmountText(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
  else {
    // One minus sign, before the number: "-5.00", "−$5.00", "$-5.00", "USD -5.00".
    const signs = text.match(/[-−–]/g)?.length ?? 0;
    if (signs === 1 && text.search(/[-−–]/) < text.search(/\d/)) text = text.replace(/[-−–]/, '');
  }
  return /[-−–()]/.test(text) ? null : text;
}

/**
 * Read a whole-number quantity off a page, or refuse.
 *
 * Separate from `parseMinorUnits` because a quantity has no currency and no
 * fraction, and reusing the money parser for it would accept "2.00" as two,
 * which is probably right and is exactly the kind of probably we do not want
 * deciding how many of something to buy.
 */
export function parseQuantity(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 ? value : null;
}

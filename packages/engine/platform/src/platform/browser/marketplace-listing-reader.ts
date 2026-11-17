/**
 * The facts a per-seller marketplace page states about one listing, read by
 * code from the marketplace's own controls and seller widget, never from the
 * seller's listing text and never by a model.
 *
 * - The sale format comes from which purchase controls the marketplace drew:
 *   a bid control is an auction, a Buy It Now control is a fixed price, an
 *   offer control alone is Best Offer, none of them is unknown.
 * - Seller figures are read only inside the marketplace's seller card and
 *   seller-feedback section. A count is taken only where the section labels
 *   it as feedback received selling; eBay's headline score mixes buying and
 *   selling and is not taken. Anything not found there is null, and the
 *   purchase asks the owner.
 *
 * The listing description is drawn in its own frame and is not read here.
 */

export interface MarketplaceListingFacts {
  readonly url: string;
  readonly format: 'fixed-price' | 'auction' | 'best-offer' | 'unknown';
  readonly sellerFeedbackCount: number | null;
  readonly sellerPositivePercent: number | null;
  /** Whether the figures came from the marketplace's own seller widget. */
  readonly fromPlatformWidget: boolean;
  readonly sellerName: string | null;
}

/** Runs in the page. Self-contained: it is serialized and evaluated there. */
export function readMarketplaceListingFacts(): Omit<MarketplaceListingFacts, 'url'> {
  const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
  const has = (selector: string): boolean => document.querySelector(selector) !== null;
  const bid = has('#bidBtn_btn') || has('[data-testid="x-bid-action"]');
  const buyNow = has('#binBtn_btn') || has('[data-testid="x-bin-action"]');
  const offer = has('#boBtn_btn') || has('[data-testid="x-offer-action"]');
  const format = bid ? 'auction' : buyNow ? 'fixed-price' : offer ? 'best-offer' : 'unknown';

  const widgets = Array.from(document.querySelectorAll(
    '[data-testid="x-sellercard-atf"], .x-sellercard-atf, [data-testid="x-about-this-seller"], [data-testid="fdbk-seller-feedback"], .fdbk-container',
  ));
  let percent: number | null = null;
  let count: number | null = null;
  let seller: string | null = null;
  for (const widget of widgets) {
    const text = clean(widget.textContent);
    const positive = /(\d{1,3}(?:\.\d+)?)\s*%\s*positive/i.exec(text);
    if (positive && percent === null) percent = Number(positive[1]);
    const sold = /seller feedback\s*\(\s*([\d,]+)\s*\)/i.exec(text) ?? /([\d,]+)\s+(?:ratings?|feedback)\s+as\s+(?:a\s+)?seller/i.exec(text);
    if (sold && count === null) count = Number(sold[1]!.replace(/,/g, ''));
    if (seller === null) {
      const name = widget.querySelector('.x-sellercard-atf__info__about-seller a, [data-testid="str-title"] a, .x-sellercard-atf__info__about-seller');
      const value = clean(name?.textContent);
      if (value) seller = value.slice(0, 80);
    }
  }
  return {
    format,
    sellerFeedbackCount: count !== null && Number.isFinite(count) ? count : null,
    sellerPositivePercent: percent !== null && Number.isFinite(percent) && percent <= 100 ? percent : null,
    fromPlatformWidget: widgets.length > 0,
    sellerName: seller,
  };
}

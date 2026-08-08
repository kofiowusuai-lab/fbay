/**
 * Selling fees, by marketplace and seller type.
 *
 * The UK case is not a variation on the US one, it is a different regime.
 * Since 1 October 2024 eBay UK charges PRIVATE sellers no selling fees at all:
 * no final value fee, no per-order fee, no regulatory operating fee. The cost
 * moved to a buyer-side protection fee at checkout. Applying the US 13.25% to a
 * UK private seller understates every breakeven by roughly an eighth of the
 * sale price, which silently rejects deals that are genuinely profitable.
 *
 * Verified 2026-08-08 against eBay UK's published fee pages. Exceptions that
 * still cost a UK private seller: motors, listing upgrades, more than 300
 * listings a month, and 3% on items delivered overseas.
 */

// eBay US final value fee rates by internal category key.
// Source: ebay.com/help/selling/fees-credits-invoices/selling-fees.
export const US_FEE_TABLE = {
  default: 0.1325,
  phone: 0.1325,
  laptop: 0.1325,
  tablet: 0.1325,
  camera: 0.1325,
  audio: 0.1325,
  gaming_console: 0.1325,
  gaming_accessory: 0.1325,
  tv: 0.1325,
  tools: 0.1325,
  appliance: 0.1325,
  furniture: 0.1325,
  bicycle: 0.1325,
  exercise_equipment: 0.1325,
  clothing: 0.1325,
  athletic_shoes: 0.08,
  jewelry: 0.15,
  watches: 0.15,
  books_movies_music: 0.153,
  musical_instrument: 0.067,
  trading_cards: 0.1325,
  heavy_equipment: 0.03,
  toys: 0.1325,
  baby: 0.1325,
  sporting_goods: 0.1325,
  other: 0.1325,
}

// eBay UK BUSINESS seller rates. Private sellers pay nothing (see above), so
// this table only applies when sellerType is 'business'.
export const UK_BUSINESS_FEE_TABLE = {
  default: 0.1,
  phone: 0.1,
  laptop: 0.1,
  tablet: 0.1,
  camera: 0.1,
  audio: 0.1,
  gaming_console: 0.1,
  gaming_accessory: 0.1,
  tv: 0.1,
  tools: 0.1,
  appliance: 0.1,
  furniture: 0.1,
  bicycle: 0.1,
  exercise_equipment: 0.1,
  clothing: 0.1,
  athletic_shoes: 0.1,
  jewelry: 0.1,
  watches: 0.1,
  books_movies_music: 0.1,
  musical_instrument: 0.1,
  trading_cards: 0.1,
  heavy_equipment: 0.1,
  toys: 0.1,
  baby: 0.1,
  sporting_goods: 0.1,
  other: 0.1,
}

/** Kept for back-compat with existing imports; the US table is the historical default. */
export const FEE_TABLE = US_FEE_TABLE

export const PER_ORDER_FEE_LOW_CENTS = 40   // US, orders under $10
export const PER_ORDER_FEE_HIGH_CENTS = 30  // US, orders $10 and over
export const PER_ORDER_THRESHOLD_CENTS = 1000

export function feeRegime ({ marketplace = 'EBAY_US', sellerType = 'private' } = {}) {
  if (marketplace === 'EBAY_GB') {
    return sellerType === 'business'
      ? { table: UK_BUSINESS_FEE_TABLE, perOrder: false, note: 'eBay UK business seller' }
      : { table: null, perOrder: false, note: 'eBay UK private seller - no selling fees' }
  }
  return { table: US_FEE_TABLE, perOrder: true, note: 'eBay US' }
}

export function fvfRate (category, opts = {}) {
  const { table } = feeRegime(opts)
  if (!table) return 0
  return table[category] ?? table.default
}

export function perOrderFeeCents (grossCents, opts = {}) {
  if (!feeRegime(opts).perOrder) return 0
  return grossCents < PER_ORDER_THRESHOLD_CENTS ? PER_ORDER_FEE_LOW_CENTS : PER_ORDER_FEE_HIGH_CENTS
}

function roundCents (n) {
  return Math.round(n)
}

export function computeFees ({ grossCents, category, promotedRate = 0, marketplace, sellerType }) {
  const opts = { marketplace, sellerType }
  const rate = fvfRate(category, opts)
  const fvfCents = roundCents(grossCents * rate)
  const perOrderCents = perOrderFeeCents(grossCents, opts)
  const promotedCents = roundCents(grossCents * promotedRate)
  return {
    rate,
    regime: feeRegime(opts).note,
    fvfCents,
    perOrderCents,
    promotedCents,
    totalCents: fvfCents + perOrderCents + promotedCents,
  }
}

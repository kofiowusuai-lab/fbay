// eBay final value fee rates by internal category key.
// Source: ebay.com/help/selling/fees-credits-invoices/selling-fees, verified 2026-08-08.
// These change. Update here only, nothing else reads rates.
export const FEE_TABLE = {
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
  athletic_shoes: 0.08,          // athletic shoes with a total amount of $150+
  jewelry: 0.15,
  watches: 0.15,
  books_movies_music: 0.153,
  musical_instrument: 0.067,     // guitars and basses
  trading_cards: 0.1325,
  heavy_equipment: 0.03,
  toys: 0.1325,
  baby: 0.1325,
  sporting_goods: 0.1325,
  other: 0.1325,
}

export const PER_ORDER_FEE_LOW_CENTS = 40   // orders under $10
export const PER_ORDER_FEE_HIGH_CENTS = 30  // orders $10 and over
export const PER_ORDER_THRESHOLD_CENTS = 1000

export function fvfRate (category) {
  return FEE_TABLE[category] ?? FEE_TABLE.default
}

export function perOrderFeeCents (grossCents) {
  return grossCents < PER_ORDER_THRESHOLD_CENTS ? PER_ORDER_FEE_LOW_CENTS : PER_ORDER_FEE_HIGH_CENTS
}

function roundCents (n) {
  return Math.round(n)
}

export function computeFees ({ grossCents, category, promotedRate = 0 }) {
  const rate = fvfRate(category)
  const fvfCents = roundCents(grossCents * rate)
  const perOrderCents = perOrderFeeCents(grossCents)
  const promotedCents = roundCents(grossCents * promotedRate)
  return {
    rate,
    fvfCents,
    perOrderCents,
    promotedCents,
    totalCents: fvfCents + perOrderCents + promotedCents,
  }
}

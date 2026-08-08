// Parcel cost bands, all-in estimate including packaging materials.
// Calibrated against eBay Standard Envelope / USPS Ground Advantage / UPS Ground
// commercial rates for a mid-distance US shipment, 2026-08-08.
// Deliberately conservative: overestimating shipping kills marginal deals,
// which is the correct bias. A missed deal costs nothing, a bad buy costs money.
export const US_WEIGHT_BANDS = [
  { key: 'letter', maxLb: 1, costCents: 550 },
  { key: 'small', maxLb: 3, costCents: 950 },
  { key: 'medium', maxLb: 10, costCents: 1650 },
  { key: 'large', maxLb: 25, costCents: 3200 },
  { key: 'oversize', maxLb: 70, costCents: 6500 },
  { key: 'freight', maxLb: Infinity, costCents: null },
]

/**
 * UK domestic parcel bands, in pence, keyed by kg.
 * Calibrated against Evri / Royal Mail tracked rates including packaging,
 * 2026-08-08. Deliberately conservative: overestimating shipping kills marginal
 * deals, and a missed deal costs nothing while a bad buy costs money.
 */
export const UK_WEIGHT_BANDS = [
  { key: 'large_letter', maxKg: 0.75, costCents: 320 },
  { key: 'small_parcel', maxKg: 2, costCents: 450 },
  { key: 'medium_parcel', maxKg: 5, costCents: 620 },
  { key: 'large_parcel', maxKg: 10, costCents: 880 },
  { key: 'heavy', maxKg: 20, costCents: 1500 },
  { key: 'oversize', maxKg: 30, costCents: 2400 },
  { key: 'freight', maxKg: Infinity, costCents: null },
]

/** Historical default so existing imports keep working. */
export const WEIGHT_BANDS = US_WEIGHT_BANDS

export const KG_PER_LB = 0.45359237

export const CATEGORY_WEIGHT_LB = {
  default: 5,
  phone: 1,
  tablet: 2,
  laptop: 8,
  camera: 4,
  audio: 6,
  gaming_console: 12,
  gaming_accessory: 2,
  tv: 45,
  tools: 12,
  appliance: 90,
  furniture: 150,
  bicycle: 40,
  exercise_equipment: 180,
  clothing: 2,
  athletic_shoes: 3,
  jewelry: 0.5,
  watches: 1,
  books_movies_music: 2,
  musical_instrument: 20,
  trading_cards: 0.3,
  heavy_equipment: 500,
  toys: 4,
  baby: 15,
  sporting_goods: 10,
  other: 5,
}

export function bandForWeight (weightLb, marketplace = 'EBAY_US') {
  if (marketplace === 'EBAY_GB') {
    const kg = weightLb * KG_PER_LB
    return UK_WEIGHT_BANDS.find((b) => kg <= b.maxKg)
  }
  return US_WEIGHT_BANDS.find((b) => weightLb <= b.maxLb)
}

export function shippingFor ({ category, weightLb, localResale = false, marketplace = 'EBAY_US' }) {
  const lb = weightLb ?? CATEGORY_WEIGHT_LB[category] ?? CATEGORY_WEIGHT_LB.default
  const band = bandForWeight(lb, marketplace)
  if (localResale) {
    return { weightLb: lb, band, costCents: 0, freight: false, localResale: true }
  }
  return {
    weightLb: lb,
    weightKg: Math.round(lb * KG_PER_LB * 100) / 100,
    band,
    costCents: band.costCents,
    freight: band.costCents === null,
    localResale: false,
  }
}

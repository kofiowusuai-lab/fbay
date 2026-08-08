// Parcel cost bands, all-in estimate including packaging materials.
// Calibrated against eBay Standard Envelope / USPS Ground Advantage / UPS Ground
// commercial rates for a mid-distance US shipment, 2026-08-08.
// Deliberately conservative: overestimating shipping kills marginal deals,
// which is the correct bias. A missed deal costs nothing, a bad buy costs money.
export const WEIGHT_BANDS = [
  { key: 'letter', maxLb: 1, costCents: 550 },
  { key: 'small', maxLb: 3, costCents: 950 },
  { key: 'medium', maxLb: 10, costCents: 1650 },
  { key: 'large', maxLb: 25, costCents: 3200 },
  { key: 'oversize', maxLb: 70, costCents: 6500 },
  { key: 'freight', maxLb: Infinity, costCents: null },
]

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

export function bandForWeight (weightLb) {
  return WEIGHT_BANDS.find((b) => weightLb <= b.maxLb)
}

export function shippingFor ({ category, weightLb, localResale = false }) {
  const lb = weightLb ?? CATEGORY_WEIGHT_LB[category] ?? CATEGORY_WEIGHT_LB.default
  const band = bandForWeight(lb)
  if (localResale) {
    return { weightLb: lb, band, costCents: 0, freight: false, localResale: true }
  }
  return {
    weightLb: lb,
    band,
    costCents: band.costCents,
    freight: band.costCents === null,
    localResale: false,
  }
}

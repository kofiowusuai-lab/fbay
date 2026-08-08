/** Bounded, monotonic normaliser. saturate(half, half) === 0.5 by construction. */
export function saturate (value, half) {
  const v = Math.max(0, value)
  return v / (v + half)
}

const PROFIT_HALF_CENTS = 10000   // $100 net scores 0.5 on the profit axis
const ROI_HALF = 1.0              // 100% ROI scores 0.5 on the roi axis
const AGE_HALF_HOURS = 24         // 24h old scores 0.5 on the age penalty axis

export function scoreDeal ({ listing, identity, compset, profit, priceDrop }, config, now = Date.now()) {
  const w = config.weights

  const profitScore = saturate(profit.netCents ?? 0, PROFIT_HALF_CENTS)
  const roiScore = saturate(profit.roi ?? 0, ROI_HALF)
  const velocityScore = Math.min(1, Math.max(0, compset.sellThrough))
  const confidenceScore = Math.min(1, Math.max(0, identity.identityConfidence * compset.confidence))

  const hours = listing.listedAt ? Math.max(0, (now - listing.listedAt) / 3600000) : AGE_HALF_HOURS
  const agePenalty = saturate(hours, AGE_HALF_HOURS)

  let dropScore = 0
  if (priceDrop?.previousPriceCents > 0 && priceDrop.currentPriceCents >= 0) {
    dropScore = Math.min(1, Math.max(0, 1 - priceDrop.currentPriceCents / priceDrop.previousPriceCents))
  }

  const raw =
    w.profit * profitScore +
    w.roi * roiScore +
    w.velocity * velocityScore +
    w.confidence * confidenceScore +
    w.drop * dropScore -
    w.age * agePenalty

  const maxPossible = w.profit + w.roi + w.velocity + w.confidence + w.drop
  return Math.min(1, Math.max(0, raw / maxPossible))
}

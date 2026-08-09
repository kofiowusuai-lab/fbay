/**
 * Turns recorded flips into the numbers that actually matter.
 *
 * Total profit answers "did this work for me". It does not answer "is this
 * worth a subscription to someone else" - that question is answered by
 * throughput (deals surfaced per week) and by estimate accuracy (does the
 * predicted net survive contact with a real sale). A tool that finds one good
 * flip a month is a hobby; the same tool finding two a week is a business, and
 * total profit alone cannot tell those apart.
 */
export function summarise (outcomes, { firstAlertAt = null, now = Date.now() } = {}) {
  const sold = outcomes.filter((o) => o.sold_cents != null)

  const realised = sold.map((o) => ({
    ...o,
    actualNet: o.sold_cents - o.bought_cents - (o.postage_cents ?? 0) - (o.fees_cents ?? 0),
  }))

  const totalNet = realised.reduce((s, o) => s + o.actualNet, 0)
  const totalIn = realised.reduce((s, o) => s + o.bought_cents, 0)

  // != null, not truthiness: a timestamp of 0 is a valid instant, and treating
  // it as absent silently drops rows from the average.
  const held = realised
    .filter((o) => o.sold_at != null && o.bought_at != null)
    .map((o) => (o.sold_at - o.bought_at) / 86400000)

  const weeks = firstAlertAt != null ? Math.max(1, (now - firstAlertAt) / (7 * 86400000)) : null

  return {
    flips: realised.length,
    open: outcomes.length - realised.length,
    totalNetCents: totalNet,
    avgNetCents: realised.length ? Math.round(totalNet / realised.length) : null,
    capitalDeployedCents: totalIn,
    returnOnCapital: totalIn ? totalNet / totalIn : null,
    avgDaysToSell: held.length ? Math.round((held.reduce((a, b) => a + b, 0) / held.length) * 10) / 10 : null,
    flipsPerWeek: weeks != null ? Math.round((realised.length / weeks) * 10) / 10 : null,
    weeklyNetCents: weeks != null ? Math.round(totalNet / weeks) : null,
  }
}

/**
 * How well the predicted net matched reality. This is the number that decides
 * whether the thresholds are trustworthy: a system that consistently overstates
 * profit will pass deals that lose money.
 */
export function accuracy (rows) {
  const paired = rows.filter((r) => r.sold_cents != null && r.net_profit_cents != null)
  if (!paired.length) return { n: 0 }

  const errors = paired.map((r) => {
    const actual = r.sold_cents - r.bought_cents - (r.postage_cents ?? 0) - (r.fees_cents ?? 0)
    return { predicted: r.net_profit_cents, actual, diff: actual - r.net_profit_cents }
  })

  const mean = errors.reduce((s, e) => s + e.diff, 0) / errors.length
  const optimistic = errors.filter((e) => e.diff < 0).length

  return {
    n: errors.length,
    meanErrorCents: Math.round(mean),
    optimisticCount: optimistic,
    // Over-predicting profit is the dangerous direction: it lets losing deals
    // through the filter. Under-predicting only costs missed opportunities.
    bias: mean < 0 ? 'over-predicts profit' : 'under-predicts profit',
  }
}

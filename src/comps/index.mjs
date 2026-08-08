import { buildCompSet } from './stats.mjs'

function rowToCompSet (row, minSampleSize) {
  return {
    identityKey: row.identity_key,
    marketplace: row.marketplace,
    trimmedMedianCents: row.trimmed_median_cents,
    p25Cents: row.p25_cents,
    p75Cents: row.p75_cents,
    sampleN: row.sample_n,
    rawN: row.raw_n,
    activeCount: row.active_count,
    soldCount: row.sold_count,
    sellThrough: row.sell_through,
    activeCountAvailable: row.active_count_available === 1,
    soldPerWeek: row.sold_per_week,
    daysOfSupply: row.days_of_supply,
    confidence: row.confidence,
    lowConfidence: row.sample_n < minSampleSize,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  }
}

/**
 * Returns {ok, compset, compsetId, cached, warnings}.
 * Sold data is required. Active data is best-effort: losing it costs us the
 * sell-through signal, not the valuation, so it degrades instead of failing.
 */
export async function getCompSet ({ identity, repo, sold, browse, config, now = Date.now() }) {
  const cachedRow = repo.getFreshCompSet(identity.identityKey, now)
  if (cachedRow) {
    return {
      ok: true,
      cached: true,
      compset: rowToCompSet(cachedRow, config.thresholds.minCompSampleSize),
      compsetId: cachedRow.id,
      warnings: [],
    }
  }

  const warnings = []
  const soldRes = await sold.fetchSold(identity.query)
  if (!soldRes.ok) return { ok: false, error: `sold comps unavailable: ${soldRes.error}`, gated: soldRes.gated, warnings }
  if (!soldRes.strategy) {
    return { ok: false, error: 'eBay sold parser matched no selector strategy (possible markup drift)', warnings }
  }

  // eBay picks display currency from the exit IP. A page of BRL prices parsed
  // as USD would value a $250 phone at $1,249 and make every listing look like
  // a windfall. Refuse the compset rather than convert with a guessed rate.
  if (soldRes.currency && soldRes.currency !== config.currency) {
    return {
      ok: false,
      currencyMismatch: true,
      error: `eBay returned ${soldRes.currency} prices, expected ${config.currency}. ` +
        'Sign in to an eBay account on the target marketplace (fbay ebay-login), or change currency in config.json.',
      warnings,
    }
  }

  let activeCount = 0
  let activeCountAvailable = true
  const browseRes = await browse.searchActive(identity.query)
  if (browseRes.ok) activeCount = browseRes.total
  else {
    activeCountAvailable = false
    warnings.push(`active-listing count unavailable: ${browseRes.error}`)
  }

  const built = buildCompSet({
    soldComps: soldRes.comps,
    activeCount,
    activeCountAvailable,
    mustTokens: identity.mustTokens,
    now,
    minSampleSize: config.thresholds.minCompSampleSize,
    marketplace: config.marketplace,
    identityKey: identity.identityKey,
    ttlHours: config.compsTtlHours,
  })

  const { comps, ...persistable } = built
  const { id } = repo.saveCompSet(persistable, comps)
  return { ok: true, cached: false, compset: built, compsetId: id, warnings }
}

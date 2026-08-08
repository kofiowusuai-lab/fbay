const DAY_MS = 86400000

const BUNDLE_RE = /\b(lot of|bundle|job lot|wholesale|\d+\s*x\s*(pack|units?)|pack of)\b/i
const PARTS_RE = /\b(for parts|parts only|not working|as-?is|spares? or repairs?)\b/i
const DAMAGED_RE = /\b(cracked|broken|damaged|read description|no power|water damage)\b/i

export function tokenize (s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
}

export function excludeReasonFor (title) {
  if (BUNDLE_RE.test(title)) return 'bundle'
  if (PARTS_RE.test(title)) return 'parts'
  if (DAMAGED_RE.test(title)) return 'damaged'
  return null
}

/**
 * A required token is matched by tokenizing it the same way the comp title is
 * tokenized, then requiring every part to be present.
 *
 * A naive `tokenSet.has(rawToken)` looks right and silently matches nothing for
 * any multi-word or punctuated token: a model returns "MacBook Pro" or
 * "16-inch", the comp title tokenizes to ["macbook","pro","16","inch"], and the
 * lookup fails on every single comp. The symptom is "no usable sold comps"
 * across the board, which reads like eBay returning nothing rather than a
 * filter bug.
 */
export function tokenMatches (mustToken, titleTokens) {
  const parts = tokenize(mustToken)
  if (!parts.length) return true
  return parts.every((p) => titleTokens.has(p))
}

export function filterComps (comps, { mustTokens = [] } = {}) {
  return comps.map((c) => {
    const heuristic = excludeReasonFor(c.title)
    if (heuristic) return { ...c, included: false, excludeReason: heuristic }
    const toks = new Set(tokenize(c.title))
    const missing = mustTokens.find((t) => !tokenMatches(t, toks))
    if (missing) return { ...c, included: false, excludeReason: `missing_token:${missing}` }
    return { ...c, included: true, excludeReason: null }
  })
}

export function median (values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function percentile (values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = (s.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

export function iqrTrim (values) {
  if (values.length < 4) return { kept: [...values], low: null, high: null }
  const q1 = percentile(values, 0.25)
  const q3 = percentile(values, 0.75)
  const iqr = q3 - q1
  const low = q1 - 1.5 * iqr
  const high = q3 + 1.5 * iqr
  return { kept: values.filter((v) => v >= low && v <= high), low, high }
}

/**
 * Sample size GATES the score, spread only modulates it. These must not be
 * independent additive terms: the spread across a single comp is trivially
 * zero, so an additive formula hands one lucky data point most of the spread
 * weight and reports high confidence on a sample of one.
 */
function confidenceFrom ({ sampleN, minSampleSize, p25, p75, med }) {
  if (!sampleN || med == null || med === 0) return 0
  const sizeScore = Math.min(1, sampleN / (minSampleSize * 2))
  const spread = (p75 - p25) / med
  const spreadScore = Math.max(0, 1 - Math.min(spread, 1))
  return Math.round(sizeScore * (0.6 + 0.4 * spreadScore) * 1000) / 1000
}

export function buildCompSet ({
  soldComps = [],
  activeCount = 0,
  activeCountAvailable = true,
  mustTokens = [],
  now = Date.now(),
  minSampleSize = 5,
  marketplace = 'EBAY_US',
  identityKey = null,
  ttlHours = 168,
}) {
  const flagged = filterComps(soldComps, { mustTokens })
  const included = flagged.filter((c) => c.included)
  const prices = included.map((c) => c.priceCents)
  const trim = iqrTrim(prices)

  const inBand = (v) => trim.low === null || (v >= trim.low && v <= trim.high)
  const keptSet = new Set()
  const kept = []
  for (const c of included) {
    if (inBand(c.priceCents)) {
      kept.push(c)
      keptSet.add(c)
    }
  }

  // Re-flag anything trimmed as an outlier so the audit trail is complete.
  const finalComps = flagged.map((c) =>
    c.included && !keptSet.has(c) ? { ...c, included: false, excludeReason: 'outlier' } : c
  )

  const keptPrices = kept.map((c) => c.priceCents)
  const med = median(keptPrices)
  const p25 = percentile(keptPrices, 0.25)
  const p75 = percentile(keptPrices, 0.75)
  const soldCount = kept.length

  const times = kept.map((c) => c.soldAt).filter((t) => typeof t === 'number')
  const spanDays = times.length > 1 ? Math.max(1, (Math.max(...times) - Math.min(...times)) / DAY_MS) : null
  const soldPerWeek = spanDays ? (soldCount / spanDays) * 7 : null
  const soldPerDay = soldPerWeek ? soldPerWeek / 7 : null
  const daysOfSupply = activeCountAvailable && soldPerDay && soldPerDay > 0 ? activeCount / soldPerDay : null

  // If the active-listing count is unavailable, sell-through is UNKNOWN, not
  // 100%. Defaulting activeCount to 0 would compute soldCount/soldCount = 1.0
  // and silently pass the sell-through gate on every item - the exact
  // failure-looks-like-success trap the canaries exist to catch.
  const denom = soldCount + activeCount
  const sellThrough = !activeCountAvailable ? null : (denom > 0 ? soldCount / denom : 0)

  return {
    identityKey,
    marketplace,
    trimmedMedianCents: med == null ? null : Math.round(med),
    p25Cents: p25 == null ? null : Math.round(p25),
    p75Cents: p75 == null ? null : Math.round(p75),
    sampleN: soldCount,
    rawN: soldComps.length,
    activeCount,
    activeCountAvailable,
    soldCount,
    sellThrough,
    soldPerWeek,
    daysOfSupply,
    confidence: confidenceFrom({ sampleN: soldCount, minSampleSize, p25, p75, med }),
    lowConfidence: soldCount < minSampleSize,
    fetchedAt: now,
    expiresAt: now + ttlHours * 3600000,
    comps: finalComps,
  }
}

import { buildCompSet } from '../comps/stats.mjs'

/**
 * Known-good queries with expected outcomes. If eBay changes its markup, these
 * fail loudly. Without them, a broken parser looks identical to a quiet market,
 * which is the single most expensive failure mode this system has.
 * Bands are deliberately wide: they catch "the parser is broken", not price drift.
 *
 * The median band also catches a currency swap. eBay serves prices in the
 * currency it infers from your exit IP, and R$1,249 parsed as $1,249 would sail
 * through every other check while making junk look like treasure.
 */
export const CANARIES = [
  { name: 'ebay_sold_iphone', query: 'iphone 13 128gb unlocked', mustTokens: ['iphone', '13'], minResults: 8, medianBandCents: [6000, 70000] },
  { name: 'ebay_sold_airpods', query: 'apple airpods pro 2nd generation', mustTokens: ['airpods'], minResults: 8, medianBandCents: [3000, 25000] },
]

export const HALT_AFTER_CONSECUTIVE_FAILURES = 2

export async function runCanary ({ canary, sold, repo, now = Date.now(), expectedCurrency = 'USD' }) {
  let res
  try {
    res = await sold.fetchSold(canary.query)
  } catch (e) {
    const reason = `canary threw: ${String(e.message ?? e).split('\n')[0].slice(0, 120)}`
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  if (!res.ok) {
    const reason = `fetch failed: ${res.error}`
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason, gated: res.gated }
  }

  if (!res.strategy || res.comps.length === 0) {
    const reason = 'no selector strategy matched (zero results) - eBay markup has probably drifted'
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  if (res.currency && res.currency !== expectedCurrency) {
    const reason = `eBay returned ${res.currency} prices, expected ${expectedCurrency} - every valuation would be wrong`
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  const cs = buildCompSet({
    soldComps: res.comps,
    activeCount: 0,
    mustTokens: canary.mustTokens,
    now,
    minSampleSize: canary.minResults,
  })

  if (cs.sampleN < canary.minResults) {
    const reason = `only ${cs.sampleN} usable comps, expected at least ${canary.minResults}`
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  const [lo, hi] = canary.medianBandCents
  if (cs.trimmedMedianCents < lo || cs.trimmedMedianCents > hi) {
    const reason = `median $${(cs.trimmedMedianCents / 100).toFixed(2)} outside sanity band $${lo / 100}-$${hi / 100} - prices are being misparsed`
    repo.recordCanary(canary.name, false, now, reason)
    return { ok: false, name: canary.name, reason }
  }

  repo.recordCanary(canary.name, true, now, null)
  return { ok: true, name: canary.name, sampleN: cs.sampleN, medianCents: cs.trimmedMedianCents, strategy: res.strategy }
}

export async function runAllCanaries ({ sold, repo, notifier, now = Date.now(), expectedCurrency = 'USD' }) {
  const results = []
  for (const c of CANARIES) results.push(await runCanary({ canary: c, sold, repo, now, expectedCurrency }))
  const failed = results.filter((r) => !r.ok)
  if (failed.length && notifier) {
    await notifier.notifyAlert(`canary failure - ${failed.map((f) => `${f.name}: ${f.reason}`).join(' | ')}`, { level: 'critical' })
  }
  return { ok: failed.length === 0, results, failed }
}

export function scanningShouldHalt (repo) {
  return CANARIES.some((c) => (repo.getCanary(c.name)?.consecutive_failures ?? 0) >= HALT_AFTER_CONSECUTIVE_FAILURES)
}

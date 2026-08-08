import { getCompSet } from '../comps/index.mjs'
import { computeProfit } from '../economics/profit.mjs'
import { applyFilters } from '../score/filters.mjs'
import { scoreDeal } from '../score/rank.mjs'

/**
 * Runs one listing through identify -> comps -> economics -> filters -> score.
 * Any stage failure returns {ok:false, status:'needs_review'} with the reason,
 * so the listing is recorded rather than silently lost.
 */
export async function evaluateListing ({ listing, repo, config, identifier, sold, browse, now = Date.now(), priceDrop = null }) {
  const idRes = await identifier({ listing, repo, config })
  if (!idRes.ok) return { ok: false, status: 'needs_review', error: `identify failed: ${idRes.error}` }
  const identity = idRes.identity

  const compRes = await getCompSet({ identity, repo, sold, browse, config, now })
  if (!compRes.ok) return { ok: false, status: 'needs_review', error: `comps failed: ${compRes.error}`, identity }
  const compset = compRes.compset

  if (compset.trimmedMedianCents == null) {
    return { ok: false, status: 'needs_review', error: 'no usable sold comps', identity, compset, compsetId: compRes.compsetId }
  }

  const profit = computeProfit({
    grossCents: compset.trimmedMedianCents,
    askCents: listing.priceCents,
    category: identity.category,
    config,
    weightLb: identity.weightLb,
    localResale: listing.delivery === 'pickup' && config.freight.enabled,
  })

  const { passed, rejections } = applyFilters({ listing, identity, compset, profit }, config)
  const score = scoreDeal({ listing, identity, compset, profit, priceDrop }, config, now)

  return {
    ok: true,
    passed,
    rejections,
    score,
    identity,
    compset,
    compsetId: compRes.compsetId,
    profit,
    confidence: identity.identityConfidence * compset.confidence,
    warnings: compRes.warnings,
  }
}

export async function runWatch ({
  watch, source, repo, config, identifier, sold, browse, notifier,
  now = Date.now(),
  fetchDetails = true,
  limit = null,
  onProgress = null,
}) {
  const runId = repo.startRun(watch.id ?? null, now)
  const errors = []
  let listingsSeen = 0
  let listingsNew = 0
  let dealsFound = 0

  const scan = await source.scan(watch, { fetchDetails, limit, onProgress })
  if (!scan.ok) {
    repo.finishRun(runId, { now, listingsSeen: 0, listingsNew: 0, dealsFound: 0, errors: [scan.error], status: 'failed' })
    return { ok: false, error: scan.error, kind: scan.kind, runId }
  }

  for (const w of scan.warnings ?? []) errors.push(w)

  // Evaluating a listing costs a model call and an eBay lookup. When the
  // provider is slow (the Codex CLI spawns a whole agent per call, ~20s), a
  // full watch can run for 20+ minutes. `limit` evaluates the cheapest asks
  // first, which is where the mispricing lives anyway.
  // source.scan already bounded the work when `limit` was set, so this is a
  // belt-and-braces cap for sources that ignore the option.
  const queue = limit ? scan.listings.slice(0, limit) : scan.listings

  let index = 0
  for (const listing of queue) {
    index++
    listingsSeen++
    onProgress?.({ index, total: queue.length, listing })
    const up = repo.upsertListing({ ...listing, watchId: watch.id ?? null })
    if (up.isNew) listingsNew++
    if (listing.description || listing.sellerName) repo.updateListingDetail(listing.fbId, listing)

    // Re-evaluate only new listings or ones whose price moved. Everything else
    // is unchanged since the last pass and re-running it wastes model and eBay calls.
    if (!up.isNew && !up.priceChanged) continue

    const priceDrop = up.priceChanged && up.previousPriceCents > listing.priceCents
      ? { previousPriceCents: up.previousPriceCents, currentPriceCents: listing.priceCents }
      : null

    const ev = await evaluateListing({ listing, repo, config, identifier, sold, browse, now, priceDrop })

    if (!ev.ok) {
      errors.push(`${listing.fbId}: ${ev.error}`)
      repo.upsertDeal({ listingId: up.id, status: 'needs_review', error: ev.error, identityKey: ev.identity?.identityKey, now })
      continue
    }

    const status = ev.passed ? 'alerted' : 'passed'
    repo.upsertDeal({
      listingId: up.id,
      identityKey: ev.identity.identityKey,
      compsetId: ev.compsetId,
      grossCents: ev.compset.trimmedMedianCents,
      netProfitCents: ev.profit.netCents,
      roi: ev.profit.roi,
      margin: ev.profit.margin,
      breakevenBuyCents: ev.profit.breakevenBuyCents,
      score: ev.score,
      confidence: ev.confidence,
      status,
      rejections: ev.rejections,
      now,
    })

    onProgress?.({ index, total: queue.length, listing, evaluation: ev })

    if (ev.passed) {
      dealsFound++
      await notifier.notifyDeal({ listing, identity: ev.identity, compset: ev.compset, profit: ev.profit, score: ev.score, priceDrop })
    }
  }

  if (watch.id) repo.touchWatch(watch.id, now)
  repo.finishRun(runId, { now, listingsSeen, listingsNew, dealsFound, errors, status: 'ok' })
  return { ok: true, runId, listingsSeen, listingsNew, dealsFound, errors }
}

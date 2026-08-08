import { buildSearchUrl } from './search.mjs'
import { parseListingNodes } from './parse.mjs'
import { parseDetail } from './detail.mjs'
import { PaceLimitError } from './pace.mjs'

/**
 * The Source interface: scan(watch) -> {ok, listings, warnings, blocked}.
 * A second source (Apify, another marketplace) only has to satisfy this shape.
 */
export function createFacebookSource ({ session, pacer, clock = Date.now, scrolls = 3 }) {
  async function scan (watch, { fetchDetails = true, limit = null, onProgress = null } = {}) {
    const warnings = []
    const url = buildSearchUrl({
      city: watch.city,
      query: watch.query,
      category: watch.category,
      minPriceCents: watch.min_price_cents ?? watch.minPriceCents,
      maxPriceCents: watch.max_price_cents ?? watch.maxPriceCents,
      radiusKm: watch.radius_km ?? watch.radiusKm,
      sort: watch.sort,
    })

    try {
      await pacer.beforeRequest()
    } catch (e) {
      if (e instanceof PaceLimitError) return { ok: false, error: e.message, kind: e.kind, listings: [], warnings }
      throw e
    }

    const nav = await session.goto(url)
    if (nav.block.blocked) {
      const info = pacer.recordBlock(nav.block.kind)
      return {
        ok: false,
        blocked: true,
        kind: nav.block.kind,
        error: `facebook blocked us: ${nav.block.kind}`,
        cooldownUntil: info.cooldownUntil,
        listings: [],
        warnings,
      }
    }

    await session.scroll(scrolls)
    const nodes = await session.extractNodes()
    const listings = parseListingNodes(nodes, { now: clock() })
    pacer.countListings(listings.length)

    if (!fetchDetails) return { ok: true, listings, warnings, url }

    // Detail pages are the expensive part of a scan - each is a full Facebook
    // SPA load behind a pacing delay - so a bounded run must choose carefully.
    //
    // Feed order, NOT cheapest-first. The search is sorted newest-first, and
    // being early to a fresh listing is the whole edge in arbitrage. Sorting by
    // price instead sends the budget to the bottom of the market, which on
    // Marketplace is empty boxes, phone cases and $1 bait listings - measured,
    // not assumed: a cheapest-first pass spent every slot on exactly those.
    const targets = limit ? listings.slice(0, limit) : listings

    const detailed = []
    let done = 0
    for (const l of targets) {
      onProgress?.({ phase: 'detail', done: ++done, total: targets.length, listing: l })
      if (pacer.listingBudgetExhausted()) { warnings.push('daily listing budget exhausted'); break }
      if (!pacer.shouldFetchDetail()) { detailed.push(l); continue }
      try {
        await pacer.beforeRequest()
      } catch (e) {
        if (e instanceof PaceLimitError) { warnings.push(e.message); detailed.push(l); break }
        throw e
      }
      const dnav = await session.goto(l.url, { waitMs: 2000 })
      if (dnav.block.blocked) {
        pacer.recordBlock(dnav.block.kind)
        warnings.push(`blocked on detail fetch: ${dnav.block.kind}`)
        detailed.push(l)
        break
      }
      const raw = await session.extractDetail()
      const detail = parseDetail({ ...raw, now: clock() })
      detailed.push({
        ...l,
        ...detail,
        imageUrls: detail.imageUrls?.length ? detail.imageUrls : l.imageUrls,
      })
    }

    return { ok: true, listings: detailed, warnings, url }
  }

  return { name: 'facebook', scan }
}

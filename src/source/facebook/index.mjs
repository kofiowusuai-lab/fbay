import { buildSearchUrl } from './search.mjs'
import { parseListingNodes } from './parse.mjs'
import { parseDetail } from './detail.mjs'
import { PaceLimitError } from './pace.mjs'

/**
 * The Source interface: scan(watch) -> {ok, listings, warnings, blocked}.
 * A second source (Apify, another marketplace) only has to satisfy this shape.
 */
export function createFacebookSource ({ session, pacer, clock = Date.now, scrolls = 3 }) {
  async function scan (watch, { fetchDetails = true } = {}) {
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

    const detailed = []
    for (const l of listings) {
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

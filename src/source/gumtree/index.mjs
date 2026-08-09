import path from 'node:path'
import { chromium } from 'playwright'
import { buildGumtreeUrl, parseGumtreeCards, EXTRACT_GUMTREE_FN } from './parse.mjs'
import { PaceLimitError } from '../facebook/pace.mjs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const BLOCKED_RE = /(access denied|are you a robot|unusual traffic|captcha)/i

export async function openGumtreeSession ({
  profileDir = process.env.FBAY_GUMTREE_PROFILE_DIR || './gumtree-profile',
  headless = true,
  browserType = chromium,
} = {}) {
  const context = await browserType.launchPersistentContext(path.resolve(profileDir), {
    headless,
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-GB',
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = context.pages()[0] ?? (await context.newPage())

  return {
    context,
    page,
    async close () { await context.close().catch(() => {}) },
    async goto (url, { waitMs = 3500, timeout = 45000 } = {}) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        await page.waitForTimeout(waitMs)
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000))
        return {
          ok: true,
          url: page.url(),
          block: BLOCKED_RE.test(bodyText) ? { blocked: true, kind: 'bot_check' } : { blocked: false, kind: null },
        }
      } catch (e) {
        return { ok: false, url, block: { blocked: false, kind: null }, error: `navigation failed: ${String(e.message ?? e).split('\n')[0].slice(0, 120)}` }
      }
    },
    async extractCards () { return page.evaluate(EXTRACT_GUMTREE_FN) },
  }
}

/**
 * Satisfies the same Source interface as the Facebook source: scan(watch) ->
 * {ok, listings, warnings}. Nothing downstream - identify, comps, economics,
 * scoring, alerts - knows or cares which marketplace a listing came from.
 *
 * Gumtree needs no login and puts price, title and location directly on the
 * search card, so unlike Facebook there is no per-listing detail fetch. That
 * makes it both cheaper to scan and far less risky per request.
 */
export function createGumtreeSource ({ session, pacer, clock = Date.now }) {
  async function scan (watch, { limit = null } = {}) {
    const warnings = []
    const url = buildGumtreeUrl({
      query: watch.query,
      city: watch.city,
      distanceMiles: Math.round((watch.radius_km ?? watch.radiusKm ?? 48) * 0.621371),
      maxPriceCents: watch.max_price_cents ?? watch.maxPriceCents,
      minPriceCents: watch.min_price_cents ?? watch.minPriceCents,
    })

    try {
      await pacer.beforeRequest()
    } catch (e) {
      if (e instanceof PaceLimitError) return { ok: false, error: e.message, kind: e.kind, listings: [], warnings }
      throw e
    }

    const nav = await session.goto(url)
    if (nav.ok === false) return { ok: false, error: nav.error, listings: [], warnings }
    if (nav.block.blocked) {
      const info = pacer.recordBlock(nav.block.kind)
      return { ok: false, blocked: true, kind: nav.block.kind, error: `gumtree blocked us: ${nav.block.kind}`, cooldownUntil: info.cooldownUntil, listings: [], warnings }
    }

    const listings = parseGumtreeCards(await session.extractCards(), { now: clock() })
    pacer.countListings(listings.length)

    return { ok: true, listings: limit ? listings.slice(0, limit) : listings, warnings, url }
  }

  return { name: 'gumtree', scan }
}

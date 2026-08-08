import path from 'node:path'
import { chromium } from 'playwright'
import { parseSoldHtml, soldSearchUrl, detectGate } from './ebay-sold.mjs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * eBay serves sold/completed listings only to signed-in accounts, and blocks
 * plain HTTP clients with a 403 error page. So sold comps go through a real
 * browser with a persisted eBay login, exactly like the Facebook source.
 *
 * A signed-in account also pins the site preference to a single marketplace,
 * which is what keeps prices in one currency instead of whatever eBay infers
 * from the exit IP.
 */
export async function openEbaySession ({
  profileDir = process.env.FBAY_EBAY_PROFILE_DIR || './ebay-profile',
  headless = true,
  browserType = chromium,
} = {}) {
  const context = await browserType.launchPersistentContext(path.resolve(profileDir), {
    headless,
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = context.pages()[0] ?? (await context.newPage())

  return {
    context,
    page,
    async close () { await context.close() },

    /**
     * Definitive, not a text sniff. Sniffing the header for "Sign in" reported
     * a signed-in session on a profile that had never logged in, while the
     * canaries correctly failed on the sign-in wall. A doctor that lies about
     * the thing it exists to check is worse than no doctor.
     *
     * This loads a page that requires authentication and sees whether eBay
     * keeps us there or bounces us to the sign-in flow.
     */
    async isSignedIn () {
      await page.goto('https://www.ebay.com/mye/myebay/summary', { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(2000)
      const url = page.url()
      const title = await page.title()
      return !/signin|sign in or register|security measure/i.test(`${url} ${title}`)
    },

    async fetchHtml (url, { waitMs = 3500 } = {}) {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(waitMs)
      return { status: res?.status() ?? 0, html: await page.content(), title: await page.title() }
    },
  }
}

/**
 * Satisfies the same {fetchSold(query)} interface as createSoldClient, so
 * comps/index.mjs is unchanged. Takes an already-open session.
 */
export function createBrowserSoldClient ({ session, expectedCurrency = 'USD', warmUp = true }) {
  let warmed = false

  async function fetchSold (query, opts = {}) {
    const url = soldSearchUrl(query, opts)

    // A cold context hitting /sch directly reads as a bot. One homepage visit
    // establishes the session cookies eBay expects.
    if (warmUp && !warmed) {
      await session.fetchHtml('https://www.ebay.com/', { waitMs: 1500 })
      warmed = true
    }

    const { status, html, title } = await session.fetchHtml(url)

    const gate = detectGate(html, title)
    if (gate.gated) return { ok: false, error: gate.reason, gated: true, url, status }

    if (status >= 400) return { ok: false, error: `eBay returned ${status}`, url, status }

    const parsed = parseSoldHtml(html)
    if (!parsed.strategy) {
      return { ok: false, error: 'eBay sold parser matched no selector strategy (possible markup drift)', url, status }
    }

    if (parsed.currency && parsed.currency !== expectedCurrency) {
      return {
        ok: false,
        error: `eBay returned prices in ${parsed.currency}, expected ${expectedCurrency}. ` +
          'eBay picks currency from your exit IP, so these numbers would be wrong. ' +
          'Sign in to a US eBay account (fbay ebay-login) or set currency in config.json.',
        currencyMismatch: true,
        got: parsed.currency,
        url,
        status,
      }
    }

    return { ok: true, ...parsed, url, status }
  }

  return { fetchSold }
}

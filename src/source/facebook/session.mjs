import path from 'node:path'
import { chromium } from 'playwright'

const CHECKPOINT_RE = /\/checkpoint\//
const LOGIN_RE = /\/login\/?/
const BLOCKED_RE = /(temporarily blocked|you're blocked|unusual activity|please try again later)/i
const LOGIN_FORM_RE = /(log ?in(to)? facebook|email or phone.*password)/i

export function detectBlock ({ url, bodyText }) {
  if (CHECKPOINT_RE.test(url)) return { blocked: true, kind: 'checkpoint' }
  if (LOGIN_RE.test(url)) return { blocked: true, kind: 'login_wall' }
  if (BLOCKED_RE.test(bodyText ?? '')) return { blocked: true, kind: 'temporarily_blocked' }
  return { blocked: false, kind: null }
}

export function isLoggedInFromText (bodyText) {
  return !LOGIN_FORM_RE.test(String(bodyText ?? '').toLowerCase())
}

/**
 * Runs inside the page. Must be fully self-contained: no closures, no imports.
 * Returns a flat array of {href, lines, image} for every marketplace item
 * anchor, which parse.mjs turns into listings. Selecting by href pattern rather
 * than class name is what makes this survive Facebook's rotating obfuscated
 * class names.
 */
export function EXTRACT_NODES_FN () {
  const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'))
  return anchors.map((a) => ({
    href: a.getAttribute('href') || '',
    lines: (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean),
    image: (a.querySelector('img') || {}).src || null,
  }))
}

export function EXTRACT_DETAIL_FN () {
  const main = document.querySelector('[role="main"]') || document.body
  return {
    bodyLines: (main.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean),
    imageUrls: Array.from(document.querySelectorAll('img'))
      .map((i) => i.src)
      .filter((s) => s && s.indexOf('scontent') !== -1 && s.indexOf('data:') !== 0)
      .slice(0, 6),
  }
}

export async function openSession ({
  profileDir = process.env.FBAY_FB_PROFILE_DIR || './fb-profile',
  headless = true,
  browserType = chromium,
} = {}) {
  const context = await browserType.launchPersistentContext(path.resolve(profileDir), {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = context.pages()[0] ?? (await context.newPage())

  return {
    context,
    page,
    async close () { await context.close() },

    async goto (url, { waitMs = 2500 } = {}) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(waitMs)
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000))
      return { url: page.url(), bodyText, block: detectBlock({ url: page.url(), bodyText }) }
    },

    /**
     * The `c_user` cookie is Facebook's canonical logged-in marker and holds the
     * account id. Checking it is definitive; sniffing body text for a login form
     * reported a valid session on a profile that had never logged in, because
     * Facebook serves Marketplace with a login modal and no /login in the URL.
     * The page checks still run, so a checkpoint on a real session fails too.
     */
    async isLoggedIn () {
      await page.goto('https://www.facebook.com/marketplace/', { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(2000)
      const cookies = await context.cookies('https://www.facebook.com')
      const hasSession = cookies.some((c) => c.name === 'c_user' && c.value)
      if (!hasSession) return false
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000))
      return isLoggedInFromText(bodyText) && !detectBlock({ url: page.url(), bodyText }).blocked
    },

    async extractNodes () { return page.evaluate(EXTRACT_NODES_FN) },
    async extractDetail () { return page.evaluate(EXTRACT_DETAIL_FN) },

    async scroll (times = 3, pauseMs = 1200) {
      for (let i = 0; i < times; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9))
        await page.waitForTimeout(pauseMs)
      }
    },
  }
}

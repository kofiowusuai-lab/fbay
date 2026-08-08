#!/usr/bin/env node
import 'dotenv/config'
import fs from 'node:fs'
import { loadConfig, requireEnv } from './config.mjs'
import { openDb } from './db/db.mjs'
import { createRepo } from './db/repo.mjs'
import { createBrowseClient } from './comps/ebay-browse.mjs'
import { createSoldClient } from './comps/ebay-sold.mjs'
import { openEbaySession, createBrowserSoldClient } from './comps/ebay-browser.mjs'
import { getCompSet } from './comps/index.mjs'
import { openSession } from './source/facebook/session.mjs'
import { createFacebookSource } from './source/facebook/index.mjs'
import { createPacer } from './source/facebook/pace.mjs'
import { createLlmClient, detectAuth } from './llm.mjs'
import { identify } from './identify/extract.mjs'
import { evaluateListing, runWatch } from './watch/runner.mjs'
import { extractFbId, parsePriceCents } from './source/facebook/parse.mjs'
import { parseDetail } from './source/facebook/detail.mjs'
import { draftOffer } from './notify/draft.mjs'
import { createTelegramNotifier } from './notify/telegram.mjs'
import { runAllCanaries, scanningShouldHalt } from './watch/canary.mjs'
import { runLoop } from './watch/schedule.mjs'

export function money (cents) {
  if (cents == null) return 'n/a'
  return `$${(cents / 100).toFixed(2)}`
}

export function pct (x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`
}

function buildContext () {
  const config = loadConfig()
  const repo = createRepo(openDb())
  const browse = createBrowseClient({
    appId: process.env.EBAY_APP_ID,
    certId: process.env.EBAY_CERT_ID,
    marketplace: config.marketplace,
  })
  return { config, repo, browse }
}

/**
 * eBay serves sold listings only to signed-in accounts and 403s plain HTTP
 * clients, so the default sold client is browser-backed. FBAY_SOLD=fetch forces
 * the plain client, which is only useful for offline testing.
 */
async function openSoldClient (config, { headless = true } = {}) {
  if (process.env.FBAY_SOLD === 'fetch') {
    return { sold: createSoldClient(), close: async () => {} }
  }
  const session = await openEbaySession({ headless })
  return {
    sold: createBrowserSoldClient({ session, expectedCurrency: config.currency }),
    session,
    close: () => session.close(),
  }
}

const COMMANDS = {
  async comps (args) {
    const query = args.join(' ')
    if (!query) {
      console.error('usage: fbay comps "<search query>"')
      process.exitCode = 1
      return
    }
    const env = requireEnv(process.env, ['EBAY_APP_ID', 'EBAY_CERT_ID'])
    if (!env.ok) console.warn(`warning: missing ${env.missing.join(', ')} - active counts will be unavailable`)

    const { config, repo, browse } = buildContext()
    const { sold, close } = await openSoldClient(config)
    const identity = {
      identityKey: `adhoc:${query.toLowerCase()}`,
      query,
      mustTokens: [],
      category: 'other',
    }
    const r = await getCompSet({ identity, repo, sold, browse, config })
    await close()

    if (!r.ok) {
      console.error(`\n  failed: ${r.error}\n`)
      process.exitCode = 1
      return
    }
    const c = r.compset
    for (const w of r.warnings) console.warn(`warning: ${w}`)
    console.log(`\n  ${query}${r.cached ? '  (cached)' : ''}\n`)
    console.log(`  median sold   ${money(c.trimmedMedianCents)}`)
    console.log(`  range         ${money(c.p25Cents)} - ${money(c.p75Cents)}`)
    console.log(`  comps used    ${c.sampleN} of ${c.rawN}`)
    console.log(`  active now    ${c.activeCount}`)
    console.log(`  sell-through  ${pct(c.sellThrough)}`)
    console.log(`  velocity      ${c.soldPerWeek ? c.soldPerWeek.toFixed(1) + '/week' : 'n/a'}`)
    console.log(`  confidence    ${pct(c.confidence)}${c.lowConfidence ? '  (low sample)' : ''}\n`)
  },

  async login () {
    console.log('\n  Opening a dedicated browser for FBay.')
    console.log('  This is a SEPARATE profile from your normal Chrome, so signing in')
    console.log('  there does not count. Log in in the window that opens.\n')
    console.log('  Use a secondary Facebook account.\n')

    const session = await openSession({ headless: false })
    await session.page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {})

    // Poll for the real success condition - the c_user cookie - rather than a
    // URL change. Facebook keeps /login in the URL through 2FA and checkpoint
    // redirects, so a URL watcher reports failure on a login that worked.
    const deadline = Date.now() + 300000
    let ok = false
    while (Date.now() < deadline) {
      try {
        const cookies = await session.context.cookies('https://www.facebook.com')
        if (cookies.some((c) => c.name === 'c_user' && c.value)) { ok = true; break }
      } catch {
        console.log('\n  Browser window closed before login completed.')
        break
      }
      await new Promise((r) => setTimeout(r, 2000))
    }

    if (ok) {
      console.log('\n  Logged in. Session saved to ./fb-profile - you will not need to do this again.\n')
    } else {
      console.log('\n  No Facebook session detected. Run `fbay login` again and complete the login')
      console.log('  in the window FBay opens (not your normal browser).\n')
      process.exitCode = 1
    }
    await session.close().catch(() => {})
  },

  async 'ebay-login' () {
    console.log('\n  Opening a dedicated browser for FBay (separate from your normal Chrome).')
    console.log('  Sign into an account on the marketplace you want prices from:')
    console.log('  eBay picks display currency from your account and exit IP.\n')

    const session = await openEbaySession({ headless: false })
    await session.page.goto('https://www.ebay.com/signin/', { waitUntil: 'domcontentloaded' }).catch(() => {})

    const deadline = Date.now() + 300000
    let ok = false
    while (Date.now() < deadline) {
      try {
        const url = session.page.url()
        if (!/signin|checkout/i.test(url)) {
          if (await session.isSignedIn()) { ok = true; break }
        }
      } catch {
        console.log('\n  Browser window closed before sign-in completed.')
        break
      }
      await new Promise((r) => setTimeout(r, 3000))
    }

    console.log(ok
      ? '\n  Signed in. Session saved to ./ebay-profile.\n'
      : '\n  No eBay session detected. Run `fbay ebay-login` again.\n')
    if (!ok) process.exitCode = 1
    await session.close().catch(() => {})
  },

  async watch (args) {
    const { repo } = buildContext()
    const [sub, ...rest] = args
    const flag = (name) => { const i = rest.indexOf(`--${name}`); return i === -1 ? undefined : rest[i + 1] }

    if (sub === 'add') {
      const name = flag('name')
      const city = flag('city')
      if (!name || !city) {
        console.error('usage: fbay watch add --name X --city nyc [--query "..."] [--category electronics] [--min 50] [--max 500] [--radius 40] [--interval 60]')
        process.exitCode = 1
        return
      }
      repo.addWatch({
        name,
        city,
        query: flag('query') ?? '',
        category: flag('category'),
        radiusKm: flag('radius') ? Number(flag('radius')) : 40,
        minPriceCents: flag('min') ? Number(flag('min')) * 100 : null,
        maxPriceCents: flag('max') ? Number(flag('max')) * 100 : null,
        intervalMinutes: flag('interval') ? Number(flag('interval')) : 60,
      })
      console.log(`added watch "${name}"`)
      return
    }
    if (sub === 'rm') { repo.removeWatch(rest[0]); console.log(`removed ${rest[0]}`); return }
    if (sub === 'enable' || sub === 'disable') {
      repo.setWatchEnabled(rest[0], sub === 'enable')
      console.log(`${sub}d ${rest[0]}`)
      return
    }
    const rows = repo.listWatches()
    if (!rows.length) { console.log('no watches. add one: fbay watch add --name X --city nyc --query "macbook"'); return }
    console.table(rows.map((w) => ({
      name: w.name, city: w.city, query: w.query || w.category, radius: w.radius_km,
      max: w.max_price_cents ? money(w.max_price_cents) : '', every: `${w.interval_minutes}m`, enabled: !!w.enabled,
    })))
  },

  async scan (args) {
    const dry = args.includes('--dry')
    const nameIdx = args.indexOf('--watch')
    const watchName = nameIdx !== -1 ? args[nameIdx + 1] : null

    const { config, repo } = buildContext()
    const watches = repo.listWatches({ enabledOnly: true }).filter((w) => !watchName || w.name === watchName)
    if (!watches.length) {
      console.error('no enabled watches. add one with: fbay watch add --name X --city nyc --query "macbook"')
      process.exitCode = 1
      return
    }

    const session = await openSession({ headless: !process.env.FBAY_HEADED })
    const pacer = createPacer({ config: config.pace })
    const source = createFacebookSource({ session, pacer })

    for (const w of watches) {
      const r = await source.scan(w, { fetchDetails: !dry })
      if (!r.ok) { console.error(`[${w.name}] ${r.error}`); continue }
      console.log(`\n[${w.name}] ${r.listings.length} listings`)
      for (const l of r.listings) console.log(`  ${money(l.priceCents).padStart(10)}  ${l.title.slice(0, 60)}`)
      for (const warn of r.warnings) console.warn(`  warning: ${warn}`)
      if (!dry) for (const l of r.listings) repo.upsertListing({ ...l, watchId: w.id })
    }
    await session.close()
  },

  async price (args) {
    const url = args[0]
    if (!extractFbId(url ?? '')) {
      console.error('usage: fbay price <facebook marketplace item url>')
      process.exitCode = 1
      return
    }
    const { config, repo, browse } = buildContext()
    const llm = createLlmClient()

    const session = await openSession({ headless: !process.env.FBAY_HEADED })
    const nav = await session.goto(url, { waitMs: 3000 })
    if (nav.block.blocked) {
      console.error(`facebook blocked us: ${nav.block.kind}. run: fbay login`)
      await session.close()
      process.exitCode = 1
      return
    }
    const raw = await session.extractDetail()
    await session.close()

    const detail = parseDetail({ ...raw, now: Date.now() })
    const priceLine = raw.bodyLines.find((l) => parsePriceCents(l) !== null)
    const listing = {
      fbId: extractFbId(url),
      title: raw.bodyLines.find((l) => l.length > 8 && parsePriceCents(l) === null) ?? raw.bodyLines[0],
      priceCents: priceLine ? parsePriceCents(priceLine) : 0,
      url,
      seenAt: Date.now(),
      ...detail,
    }

    const { sold, close } = await openSoldClient(config)
    const ev = await evaluateListing({
      listing, repo, config, sold, browse,
      identifier: ({ listing: l }) => identify({ listing: l, repo, llm, config }),
    })
    await close()

    if (!ev.ok) {
      console.error(`\n  cannot value this listing: ${ev.error}\n`)
      process.exitCode = 1
      return
    }

    const { identity: id, compset: c, profit: p } = ev
    console.log(`\n  ${[id.brand, id.model, id.variant, id.capacity].filter(Boolean).join(' ')}`)
    console.log(`  condition ${id.condition}, identified with ${pct(id.identityConfidence)} confidence\n`)
    console.log(`  seller asks       ${money(listing.priceCents)}`)
    console.log(`  OFFER UP TO       ${money(p.breakevenBuyCents)}`)
    console.log(`  sells for         ${money(c.trimmedMedianCents)}  (${c.sampleN} comps, ${money(c.p25Cents)}-${money(c.p75Cents)})`)
    console.log(`  net at ask        ${money(p.netCents)}  roi ${p.roi == null ? 'n/a' : pct(p.roi)}`)
    console.log(`  fees              ${money(p.fvfCents + p.perOrderCents + p.promotedCents)}`)
    console.log(`  shipping          ${money(p.shippingCents)}  (${p.shippingBand}, ${p.weightLb}lb)`)
    console.log(`  buffer            ${money(p.bufferCents)}`)
    console.log(`  sell-through      ${pct(c.sellThrough)}  (${c.activeCount} active now)`)
    console.log(`\n  verdict           ${ev.passed ? 'BUY' : 'PASS'}`)
    for (const r of ev.rejections) console.log(`                    - ${r.reason}`)
    console.log('')
  },

  async deals (args) {
    const { repo } = buildContext()
    const statusIdx = args.indexOf('--status')
    const status = statusIdx !== -1 ? args[statusIdx + 1] : (args.includes('--rejected') ? 'passed' : 'alerted')
    const rows = repo.listDeals({ status, limit: 30 })
    if (!rows.length) { console.log(`no deals with status "${status}"`); return }
    for (const d of rows) {
      console.log(`\n  #${d.id}  ${d.title.slice(0, 58)}`)
      console.log(`      ask ${money(d.ask_cents)}  offer up to ${money(d.breakeven_buy_cents)}  net ${money(d.net_profit_cents)}  roi ${pct(d.roi)}  score ${d.score?.toFixed(2) ?? 'n/a'}`)
      console.log(`      ${d.url}`)
      if (d.rejections) for (const r of JSON.parse(d.rejections)) console.log(`      - ${r.reason}`)
      if (d.error) console.log(`      ! ${d.error}`)
    }
    console.log('')
  },

  async message (args) {
    const id = Number(args[0])
    if (!id) { console.error('usage: fbay message <deal_id>'); process.exitCode = 1; return }
    const { repo } = buildContext()
    const deal = repo.listDeals({ limit: 1000 }).find((d) => d.id === id)
    if (!deal) { console.error(`no deal #${id}`); process.exitCode = 1; return }

    const identityRow = repo.db.prepare('SELECT * FROM identities WHERE identity_key = ? LIMIT 1').get(deal.identity_key) ?? {}
    const llm = createLlmClient()
    const r = await draftOffer({
      listing: { title: deal.title, priceCents: deal.ask_cents, city: deal.city },
      identity: { brand: identityRow.brand, model: identityRow.model, condition: identityRow.condition },
      profit: { breakevenBuyCents: deal.breakeven_buy_cents },
      llm,
    })
    repo.saveMessage({ dealId: id, body: r.body, offerCents: r.offerCents })
    console.log(`\n  offering ${money(r.offerCents)}${r.fallback ? '  (template fallback)' : ''}\n`)
    console.log(`  ${r.body}\n`)
    console.log(`  ${deal.url}\n`)
  },

  async status (args) {
    const [id, newStatus] = args
    if (!id || !newStatus) { console.error('usage: fbay status <deal_id> <pursuing|bought|passed>'); process.exitCode = 1; return }
    const { repo } = buildContext()
    repo.setDealStatus(Number(id), newStatus)
    console.log(`deal #${id} -> ${newStatus}`)
  },

  async doctor () {
    const checks = []
    const { config, repo, browse } = buildContext()

    // A diagnostic that hangs is worse than one that fails: the operator learns
    // nothing and cannot tell which dependency is wedged. Every network check
    // gets a hard deadline and reports the timeout as its result.
    const withTimeout = async (label, ms, fn) => {
      let timer
      try {
        return await Promise.race([
          fn(),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms) }),
        ])
      } catch (e) {
        return { __error: `${label}: ${e.message}` }
      } finally {
        clearTimeout(timer)
      }
    }

    const env = requireEnv(process.env, ['EBAY_APP_ID', 'EBAY_CERT_ID'])
    checks.push({ check: 'ebay env vars', ok: env.ok, detail: env.ok ? 'all set' : `missing ${env.missing.join(', ')}` })

    // Either an API key or an `ant auth login` OAuth profile is acceptable.
    const auth = detectAuth(process.env, fs)
    checks.push({ check: 'anthropic auth', ok: auth.ok, detail: auth.detail })
    checks.push({ check: 'database', ok: true, detail: JSON.stringify(repo.stats()) })

    const tok = await withTimeout('ebay oauth', 20000, () => browse.getToken())
    checks.push({ check: 'ebay oauth', ok: tok.ok === true, detail: tok.__error ?? (tok.ok ? 'token acquired' : tok.error) })

    const notifier = createTelegramNotifier()
    checks.push({ check: 'telegram', ok: notifier.configured, detail: notifier.configured ? 'configured' : 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing' })

    const ebay = await withTimeout('ebay browser', 60000, () => openSoldClient(config))
    if (ebay.__error) {
      checks.push({ check: 'ebay session', ok: false, detail: ebay.__error })
    } else {
      const { sold, session: ebaySession, close } = ebay
      if (ebaySession) {
        const signedIn = await withTimeout('ebay signin check', 45000, () => ebaySession.isSignedIn())
        checks.push({
          check: 'ebay session',
          ok: signedIn === true,
          detail: signedIn?.__error ?? (signedIn ? 'signed in' : 'not signed in - run: fbay ebay-login'),
        })
      }
      const canaries = await withTimeout('canaries', 120000, () =>
        runAllCanaries({ sold, repo, notifier: null, expectedCurrency: config.currency }))
      if (canaries.__error) {
        checks.push({ check: 'canaries', ok: false, detail: canaries.__error })
      } else {
        for (const r of canaries.results) {
          checks.push({
            check: `canary ${r.name}`,
            ok: r.ok,
            detail: r.ok ? `${r.sampleN} comps, median ${money(r.medianCents)}, strategy ${r.strategy}` : r.reason,
          })
        }
      }
      await close().catch(() => {})
    }

    const fb = await withTimeout('facebook session', 60000, async () => {
      const session = await openSession({ headless: true })
      try {
        return { ok: await session.isLoggedIn() }
      } finally {
        await session.close().catch(() => {})
      }
    })
    checks.push({
      check: 'facebook session',
      ok: fb.ok === true,
      detail: fb.__error ?? (fb.ok ? 'session valid' : 'no session in ./fb-profile (separate from your normal Chrome) - run: fbay login'),
    })

    const halted = scanningShouldHalt(repo)
    checks.push({ check: 'scanning enabled', ok: !halted, detail: halted ? 'HALTED by canary failures' : 'ok' })

    console.table(checks.map((c) => ({ check: c.check, status: c.ok ? 'ok' : 'FAIL', detail: String(c.detail).slice(0, 90) })))
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1
  },

  async run () {
    const { config, repo, browse } = buildContext()
    const llm = createLlmClient()
    const notifier = createTelegramNotifier()
    const { sold, close } = await openSoldClient(config)

    const canaries = await runAllCanaries({ sold, repo, notifier, expectedCurrency: config.currency })
    if (!canaries.ok) console.warn('warning: canary failures detected, see fbay doctor')
    if (scanningShouldHalt(repo)) {
      console.error('scanning halted: canaries have failed repeatedly. fix the parser, then run fbay doctor.')
      await close()
      process.exitCode = 1
      return
    }

    const session = await openSession({ headless: !process.env.FBAY_HEADED })
    const pacer = createPacer({ config: config.pace })
    const source = createFacebookSource({ session, pacer })

    console.log('fbay running. ctrl-c to stop.')
    await runLoop({
      repo,
      config,
      notifier,
      runOne: (watch) => runWatch({
        watch, source, repo, config, sold, browse, notifier,
        identifier: ({ listing }) => identify({ listing, repo, llm, config }),
      }),
    })
    await session.close()
    await close()
  },

  async db (args) {
    const { repo } = buildContext()
    if (args[0] === 'prune') {
      const days = Number(args[1] ?? 180)
      repo.prune(Date.now() - days * 86400000)
      console.log(`pruned data older than ${days} days`)
      return
    }
    console.table(repo.stats())
  },
}

const HELP = `fbay - Facebook Marketplace to eBay arbitrage

setup
  fbay login                    log into Facebook once (opens a browser)
  fbay ebay-login               sign into eBay once (sold listings need it)
  fbay doctor                   check every dependency

daily
  fbay price <fb-url>           paste a listing, get a verdict and an offer ceiling
  fbay comps "<query>"          what does this sell for, and how fast
  fbay deals [--status X]       review the pipeline
  fbay message <deal_id>        draft the seller offer
  fbay status <deal_id> <s>     pursuing | bought | passed

watches
  fbay watch add --name X --city nyc --query "macbook" --max 900
  fbay watch list | enable <n> | disable <n> | rm <n>
  fbay scan [--watch X] [--dry] one pass now
  fbay run                      continuous, alerts to Telegram

maintenance
  fbay db stats | prune [days]`

async function main () {
  const [cmd, ...args] = process.argv.slice(2)
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.log(HELP)
    process.exitCode = cmd ? 1 : 0
    return
  }
  await fn(args)
}

main().catch((e) => {
  console.error(e.stack ?? String(e))
  process.exitCode = 1
})

# FBay: Facebook Marketplace → eBay Arbitrage Engine

**Date:** 2026-08-08
**Status:** Approved
**Owner:** Casper

## Purpose

Find items listed cheap on Facebook Marketplace that sell reliably for more on eBay, compute the real net profit after fees and shipping, and alert the operator fast enough to act before the listing is gone.

The system answers one question per listing: **what is the most I should offer for this, and will it actually sell?**

## Success Criteria

1. Given a saved search, the system surfaces listings ranked by expected net profit with a stated confidence.
2. Every surfaced deal carries a **breakeven buy price** and a **sell-through rate**. No deal is shown without both.
3. Profit math is exact and unit-tested: fees, shipping, and buffer are explicit line items, never hand-waved percentages.
4. Parser drift produces a loud alert, never a silent "no deals found".
5. A cold operator can run `fbay doctor` and learn exactly which dependency is broken.

## Non-Goals

- Automatically purchasing items or auto-sending messages to sellers. The system drafts, the operator sends.
- Automatically creating eBay listings for acquired inventory. Out of scope for v1.
- Multi-user or hosted SaaS. Single operator, single machine.
- Sources other than Facebook Marketplace, or destinations other than eBay. The interfaces allow both later, v1 ships one of each.

## Core Design Decisions

### 1. Sold comps, not asking prices

An active eBay listing at $400 that has sat unsold for 90 days is not evidence the item is worth $400. Valuation uses **sold** listings only. Active listings are used solely to compute competition and sell-through.

`sell_through = sold_count / (sold_count + active_count)`

Below a configurable floor (default 0.30) an item is not a deal at any price. It is future garage inventory. This single metric separates operators who compound capital from operators who accumulate stock.

### 2. Identity extraction is the hard problem

Marketplace titles are unusable as search queries. "MacBook good condition", "tv", "bike for sale". The identity layer converts `{title, description, images}` into a canonical structured identity using a vision-capable model:

```
{
  brand, model, variant, capacity, model_year,
  category,            // maps to fee + shipping tables
  condition,           // new | like_new | good | fair | for_parts
  identity_confidence, // 0..1
  query,               // canonical eBay search string
  must_tokens          // tokens a comp title MUST contain to count
}
```

Condition is mandatory output because it swings realised value by 3x on electronics. `must_tokens` is what makes comp filtering trustworthy.

### 3. Comps are trimmed, not averaged

Raw eBay sold results contain wrong models, bundles, lots, and parts-only units. The stats layer:

1. Drops any comp whose title is missing a `must_token`.
2. Drops comps flagged as lots/bundles by token heuristics (`lot of`, `bundle`, `x2`, `parts only`, `read description`).
3. Removes outliers by IQR (1.5x fence).
4. Requires a minimum surviving sample size (default 5) or marks the CompSet `low_confidence`.
5. Reports the **trimmed median**, never the mean.

### 4. Breakeven buy price is the deliverable

The operator does not need a profit estimate. They need a number to say out loud. Every alert leads with:

> Offer up to **$X**. At their ask of $Y you net $Z (ROI R%). Sell-through S%.

## Architecture

Six isolated stages connected by a SQLite pipeline. Each stage has one purpose, a defined input and output shape, and is testable without the stages around it.

```
Watch (saved search: query, category, location, radius, price range)
  │
  ▼ source/facebook          Playwright, persistent logged-in profile, paced
RawListing[]
  │
  ▼ dedupe                   fb_id seen-table, price-drop detection, re-list detection
  │
  ▼ identify                 vision + text model → Identity, cached by content hash
Identity
  │
  ▼ comps                    eBay sold scrape (value) + Browse API (competition)
CompSet                      trimmed_median, n, sell_through, days_to_sell, active_count
  │
  ▼ economics                FVF by category + per-order fee + shipping band + buffer
Profit                       net_profit, roi, margin, breakeven_buy
  │
  ▼ score + filter           composite rank, thresholds, blacklists
Deal
  │
  ├─▶ SQLite (deals)
  ├─▶ Telegram card + drafted seller offer
  └─▶ Local dashboard
```

### Module Responsibilities

| Module | Does | Does not | External deps |
|---|---|---|---|
| `config` | Load + validate config.json and env, fail loudly on missing required keys | Anything network | none |
| `db` | Schema, migrations, prepared statements, repositories | Business logic | better-sqlite3 |
| `source/facebook` | Session lifecycle, search URL construction, listing parse, detail fetch, pacing, block detection | Valuation, scoring | Playwright |
| `identify` | Ugly listing → canonical Identity, with content-hash cache | Pricing | Claude API |
| `comps` | Fetch and blend eBay sold + active into one CompSet with confidence | Fee math | eBay OAuth, HTTP |
| `economics` | Fees, shipping bands, net profit, ROI, breakeven | I/O of any kind | none (pure) |
| `score` | Composite ranking and threshold filtering | I/O of any kind | none (pure) |
| `notify` | Telegram deal card, LLM-drafted seller offer message | Deciding what is a deal | Telegram bot, Claude API |
| `watch/runner` | Orchestrate the stages for each Watch, handle partial failure | Any stage's internals | all of the above |

`economics` and `score` are pure functions with zero I/O so the money math is fully unit-tested against hand-computed values.

### File Layout

```
~/fbay/
  fbay                         # bash CLI wrapper
  package.json
  config.example.json
  README.md
  src/
    cli.mjs                    # scan | comps | deals | watch | doctor | message | db
    config.mjs
    db/
      schema.sql
      db.mjs
      repo.mjs
    source/
      index.mjs                # Source interface + registry
      facebook/
        session.mjs
        search.mjs
        parse.mjs
        detail.mjs
        pace.mjs
    identify/
      extract.mjs
      vision.mjs
      canonical.mjs
      cache.mjs
    comps/
      index.mjs
      ebay-browse.mjs
      ebay-sold.mjs
      stats.mjs
    economics/
      fees.mjs
      shipping.mjs
      profit.mjs
    score/
      rank.mjs
      filters.mjs
    notify/
      telegram.mjs
      draft.mjs
    watch/
      runner.mjs
      schedule.mjs
  dashboard/                   # Next.js 15 app router, reads SQLite directly
  test/
    fixtures/                  # saved FB + eBay payloads
    *.test.mjs
```

## Data Model

SQLite. Tables:

- **watches** — saved searches. `id, name, query, category, city, lat, lng, radius_km, min_price, max_price, sort, enabled, interval_minutes, last_run_at`
- **listings** — every listing ever seen. `id, fb_id UNIQUE, watch_id, title, description, price_cents, currency, city, lat, lng, image_urls JSON, seller_name, seller_joined, listed_at, first_seen_at, last_seen_at, is_active, delivery (pickup|shipping|both), raw JSON`
- **price_history** — `listing_id, price_cents, observed_at`. Price drops are a strong buy signal.
- **identities** — `content_hash UNIQUE, identity_key, brand, model, variant, capacity, model_year, category, condition, identity_confidence, query, must_tokens JSON, model_used, created_at`.
  - `content_hash` = hash of the listing text and first image, so re-scanning the same listing never re-bills the model.
  - `identity_key` = hash of the canonical item itself (`brand|model|variant|capacity|category|condition`), so two different listings of the same item share one cached CompSet. These are deliberately different keys: one deduplicates model calls, the other deduplicates eBay lookups.
- **compsets** — `id, identity_key, marketplace, trimmed_median_cents, p25_cents, p75_cents, sample_n, raw_n, active_count, sold_count, sell_through, avg_days_to_sell, confidence, fetched_at, expires_at`. Keyed by `identity_key` and reused until `expires_at` (default 7 days).
- **comps** — individual sold records backing a compset, retained for auditability. `compset_id, ebay_item_id, title, price_cents, shipping_cents, sold_at, condition, url, included BOOL, exclude_reason`
- **deals** — `id, listing_id, identity_key, compset_id, net_profit_cents, roi, margin, breakeven_buy_cents, score, confidence, status (new|alerted|reviewing|pursuing|bought|passed|expired|needs_review), created_at`
- **messages** — drafted seller messages. `deal_id, body, offer_cents, generated_at, sent_at, status`
- **runs** — every scan run for observability. `id, watch_id, started_at, finished_at, listings_seen, listings_new, deals_found, errors JSON, status`
- **canaries** — parser health. `name, last_ok_at, last_fail_at, consecutive_failures`

Retention: `listings` and `comps` are pruned after 180 days by `fbay db prune`. Deals and price history are kept.

### Why SQLite instead of Supabase

Single operator, single machine. The scanner requires a real browser on this Mac, so the compute is local regardless. SQLite removes a network round trip per listing, works offline, and makes the fixture-driven test suite trivial. A Supabase mirror for remote viewing is an isolated later addition behind the same repository interface, since only `db/repo.mjs` touches storage.

## The Profit Math

```
gross           = trimmed_median_sold
fvf             = gross × fvf_rate(category)          # default 0.1325, category table
per_order       = gross < $10 ? $0.40 : $0.30
shipping        = shipping_cost(category, weight_band) # or 0 for local-pickup-resale
promoted        = gross × promoted_rate                # default 0.0, configurable
buffer          = gross × buffer_rate                  # default 0.05, returns/damage/misjudgement

net             = gross − fvf − per_order − shipping − promoted − buffer − fb_price
roi             = net / fb_price
margin          = net / gross
breakeven_buy   = gross − fvf − per_order − shipping − promoted − buffer
```

`breakeven_buy` is the fb_price at which net = 0, and is the headline number in every alert.

**Freight handling.** Categories whose weight band exceeds the parcel ceiling (furniture, appliances, exercise equipment, large TVs) are marked `freight: true`. These are never scored as shippable deals. They are either excluded or surfaced separately as local-resale candidates, controlled by config. A $60 paper profit on a treadmill becomes −$120 after freight, so silently scoring them would poison the entire feed.

**Fee table.** Category-keyed with a default. eBay final value fees vary by category and by band. The table lives in `economics/fees.mjs` as data, with the source and date of each rate in a comment, so it is auditable and updatable in one place.

## Scoring

```
score = w_profit   × normalise(net_profit)
      + w_roi      × normalise(roi)
      + w_velocity × sell_through
      + w_conf     × (identity_confidence × comp_confidence)
      − w_age      × normalise(hours_since_listed)
      + w_drop     × price_drop_signal
```

Weights live in config. Hard filters run before scoring and reject on: net profit below floor, ROI below floor, sell-through below floor, identity confidence below floor, comp sample size below floor, seller or keyword blacklist, freight when freight is disabled.

Filters are separate from scoring on purpose. A filter is a rule with a reason that gets recorded, so `fbay deals --rejected` explains exactly why anything was dropped.

## Error Handling and the Silent-Failure Problem

Scrapers die quietly. eBay changes a selector, the sold-comps parser returns zero rows, and the system reports "no deals found" indefinitely while the operator assumes the market is quiet. Defences:

1. **Canary queries.** `fbay doctor` runs known-good queries against both the FB and eBay parsers where the expected result is non-empty and roughly known. Zero results, or a median outside a sanity band, records a canary failure and fires a loud Telegram alert. Two consecutive failures disables scanning until acknowledged.
2. **No dropped rows.** A listing whose comps fetch fails becomes `status: needs_review` with the error recorded. It is never silently discarded.
3. **Typed failures.** Every external call has a timeout, bounded retry with jittered backoff, and returns a typed result. A stage degrades rather than throwing through the orchestrator.
4. **Block detection.** A Facebook login wall, checkpoint, or CAPTCHA halts scanning immediately, marks the session unhealthy, and alerts. No retry hammering.
5. **Run records.** Every run writes a `runs` row with counts and errors, so a drop in `listings_seen` is visible as a trend rather than a mystery.

## Facebook Pacing and Account Safety

Scraping Marketplace violates Facebook's terms. The realistic risk is throttling or a checkpoint on the account used, so the pacing layer is a first-class module rather than a sprinkle of sleeps:

- One browser context, no parallel tabs.
- Randomised inter-action delays drawn from a human-like distribution, not a fixed sleep.
- Per-day listing budget and per-hour request ceiling, both enforced in `pace.mjs` and configurable.
- Randomised watch ordering and jittered schedule so the traffic pattern is not periodic.
- Detail pages fetched only for listings that pass a cheap pre-filter, minimising total requests.
- Recommendation recorded here: use a secondary Facebook account, not the primary.

## LLM Cost Control

- Identity extraction results are cached by `sha256(title + description + first_image_url)`. Re-scanning the same listing never re-bills.
- A cheap pre-filter runs before identification: listings whose ask already exceeds the best-known comp for a similar title are dropped without a model call.
- Haiku 4.5 handles extraction by default. Confidence below threshold escalates to Opus for that listing only.
- All model calls go through one client module so the model choice, retries, and structured-output enforcement live in a single place.

## Testing Strategy

No live network in the test suite.

- **Parsers**: asserted against saved fixtures in `test/fixtures/` for FB search results, FB detail pages, eBay sold pages, and eBay Browse API responses.
- **Pure math**: `economics` and `score` tested against hand-computed values, including boundary cases (sub-$10 per-order fee band, zero-price, freight categories, negative profit).
- **Stats**: trimming tested with constructed distributions where the correct trimmed median is known by hand, plus lot/bundle exclusion cases.
- **Identity**: golden set of real ugly Marketplace titles with a mocked model client, asserting canonical query and `must_tokens` output.
- **Pipeline integration**: one end-to-end run over fixtures with all network faked, asserting a known listing emerges with an exact expected net profit and breakeven.
- **Failure paths**: comps failure produces `needs_review`, block detection halts scanning, canary failure disables and alerts.

Run with `node --test test/*.test.mjs`, matching the existing convention on this machine.

## CLI Surface

```
fbay doctor                     # verify FB session, eBay OAuth, parsers (canary), Telegram, DB
fbay watch add|list|rm|enable   # manage saved searches
fbay scan [--watch NAME] [--dry] # one pass of the pipeline
fbay run                        # scheduled loop honouring intervals and quiet hours
fbay comps "<query>"            # ad-hoc: what does this sell for, and how fast
fbay price <fb_url>             # ad-hoc: paste a Marketplace link, get breakeven + verdict
fbay deals [--status] [--rejected] # browse the pipeline, with rejection reasons
fbay message <deal_id>          # print or regenerate the drafted seller offer
fbay db migrate|prune|stats
```

`fbay price <url>` is the highest-value command for daily use: paste any link, get an instant verdict.

## Dashboard

Next.js 15 app router, read-mostly, reading SQLite directly. Deal feed with photo, ask, breakeven, net, ROI, sell-through, confidence. Filters by watch and status. Comp detail view showing which comps were included and which were excluded and why, because trusting the number requires seeing the evidence. Status transitions (pursuing, bought, passed) write back so realised outcomes can later be compared against estimates.

## Build Order

1. **Foundation + money math.** Config, DB, schema, `economics`, `score`, `comps/stats`. Fully tested pure logic with no network. Proves the math before anything scrapes.
2. **eBay comps.** Browse API OAuth, sold-listing fetch and parse, blending, confidence. `fbay comps "<query>"` works end to end.
3. **Facebook source.** Session, search, parse, detail, pacing, block detection. `fbay scan --dry` lists real listings.
4. **Identity extraction.** Vision and text extraction, caching, pre-filter. Full pipeline connected, `fbay price <url>` works.
5. **Notification.** Telegram deal cards, drafted seller offers, scheduler, canaries and doctor.
6. **Dashboard.** Deal feed, comp evidence view, status write-back.

Each phase ends green with tests and a working CLI command, so the system produces value from phase 2 onward.

## Operator Setup Requirements

- **eBay developer account** at developer.ebay.com, free, provides App ID / Cert ID for Browse API OAuth. Steps documented in README, validated by `fbay doctor`.
- **One-time Facebook login** through a headed Playwright browser. Session persists in a local profile directory.
- **Telegram bot** already configured on this machine, reused via existing credentials.
- **Anthropic API key** for identity extraction and message drafting.

All credentials load from `.env` in the project root. No credential is ever written to the database or logs.

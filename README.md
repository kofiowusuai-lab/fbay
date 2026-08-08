# FBay

Finds underpriced Facebook Marketplace listings, values them against real eBay sold prices, and tells you the most you should offer.

## What it actually does

For every listing it finds:

1. Works out what the item is from the title, description and **photos** (a vision model, because "MacBook good condition" is not a search query).
2. Pulls eBay **sold** comps, throws out lots, parts units and outliers, and takes the trimmed median.
3. Computes sell-through (`sold / (sold + active)`). Below 30% it is not a deal at any price, it is inventory.
4. Subtracts eBay fees, shipping, and a 5% buffer to produce a **breakeven buy price**.
5. Alerts you on Telegram with that number, and drafts the message to send the seller.

## Setup

```bash
cd ~/fbay
npm install
cp .env.example .env
ln -sf ~/fbay/fbay ~/bin/fbay   # so `fbay` works from any directory
```

> The launcher lives at `~/fbay/fbay`, inside a folder of the same name. Running
> `./fbay` from your home directory hits the *folder* and fails with "permission
> denied". The symlink above avoids that entirely — after it, just type `fbay`.

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `EBAY_APP_ID`, `EBAY_CERT_ID` | developer.ebay.com → My Account → Application Keys → **Production** keyset. Free, about five minutes. |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Existing bot on this machine, or @BotFather |

Then log into both sites once. A browser opens, you log in, the session persists:

```bash
fbay login          # Facebook
fbay ebay-login     # eBay
fbay doctor
```

`doctor` must be all green before you run anything else. Every failing row names its own fix.

### Why eBay needs a login

eBay serves sold and completed listings only to signed-in accounts, and returns a 403 error page to plain HTTP clients. So sold comps go through a real browser with a persisted eBay session, the same way the Facebook source works.

Signing in also pins your marketplace. **This matters more than it sounds.** eBay picks display currency from your exit IP: from a non-US address the same URL returns `R$ 1,249.09` where a US visitor sees `$249.09`. Parsed naively that values a $250 phone at $1,249 and makes every listing look like a windfall. FBay detects the currency on every page and refuses the valuation if it does not match `currency` in your config, rather than converting with a guessed rate.

## Daily use

```bash
# Paste any Marketplace link, get a verdict
fbay price "https://www.facebook.com/marketplace/item/123456789/"

# What does this sell for, and how fast
fbay comps "dewalt dcd791 20v drill"

# Saved searches
fbay watch add --name macbooks --city nyc --query "macbook pro" --max 900 --radius 40
fbay watch list

# One pass now
fbay scan --watch macbooks
fbay scan --dry            # list what it sees, write nothing

# Run continuously, alerting to Telegram
fbay run

# Review
fbay deals
fbay deals --status needs_review
fbay message 42            # draft the seller offer
fbay status 42 pursuing
```

Dashboard:

```bash
cd dashboard && npm run dev   # http://localhost:3737
```

The deal page shows every comp behind a valuation, including the ones that were excluded and why. Trusting the number requires seeing the evidence.

## Tuning

Copy `config.example.json` to `config.json` and edit. Everything is optional, defaults are in `src/config.mjs`.

| Setting | Default | Meaning |
|---|---|---|
| `thresholds.minNetProfitCents` | 3000 | Do not alert below $30 net |
| `thresholds.minRoi` | 0.5 | Do not alert below 50% ROI |
| `thresholds.minSellThrough` | 0.30 | Do not alert on slow movers |
| `thresholds.minCompSampleSize` | 5 | Usable sold comps required for a valuation |
| `economics.bufferRate` | 0.05 | Haircut for returns, damage, misjudgement |
| `economics.promotedRate` | 0 | Set to ~0.03 if you promote listings |
| `freight.enabled` | false | Include furniture and appliances |
| `currency` | USD | Rejects comps priced in anything else |
| `pace.maxListingsPerDay` | 600 | Facebook request budget |

## Why it will not silently rot

Scrapers usually die quietly: eBay changes a selector, comps return zero, and the system reports "no deals" forever while you assume the market is slow.

- `fbay doctor` runs **canary queries** with known-good expected results. Zero results, a currency swap, or a median outside a sanity band all fail loudly.
- Two consecutive canary failures **halt scanning** rather than producing garbage.
- Every doctor check has a hard deadline. A wedged dependency reports "timed out", never hangs.
- Session checks are definitive, not text sniffs: Facebook is verified by the `c_user` cookie, eBay by loading an authenticated page. An earlier text-based version reported a valid session on a profile that had never logged in.
- A listing whose comps fail becomes `needs_review`, never a dropped row.
- **An unknown is never treated as a pass.** If the eBay Browse API is down, the active-listing count is missing, so sell-through is recorded as `null` rather than defaulting to 100% and silently disabling the sell-through gate. Deals in that state are rejected with `sell_through_unavailable` until the count is available again.
- A Facebook checkpoint or login wall stops the run immediately and starts an escalating cooldown.

## Account safety

Scraping Marketplace is against Facebook's terms. The realistic risk is a checkpoint on the account you use, not legal action. Pacing (`src/source/facebook/pace.mjs`) enforces an hourly request ceiling, a daily listing budget, human-shaped delays and shuffled watch order. **Use a secondary Facebook account.**

## Tests

```bash
node --test test/*.test.mjs
```

204 tests, no live network. eBay parsing is asserted against a fixture captured from the live site in `test/fixtures/`.

## Architecture

```
source/facebook  →  identify  →  comps  →  economics  →  score  →  notify
   Playwright       vision LLM    eBay      pure math    pure math   Telegram
```

`economics` and `score` have zero I/O and are fully unit-tested against hand-computed values. Every network stage parses through a pure function fed by fixtures. Only `db/repo.mjs` knows SQLite exists, so swapping in Supabase later touches one file.

Design spec and implementation plan: `docs/superpowers/`.

## Known limits

- **Sold-comp velocity** is derived from the date span of the sold results, not from listing duration, because eBay does not expose when a sold listing started. `soldPerWeek` and `daysOfSupply` are honest proxies; there is no true days-to-sell.
- **Shipping is banded, not quoted.** Costs come from a weight-band table calibrated conservatively. Freight-class items are flagged and excluded rather than estimated, because a wrong freight quote turns a $60 paper profit into a $120 loss.
- **The fee table is a snapshot** (2026-08-08) and eBay changes rates. It lives in one place, `src/economics/fees.mjs`, with the source noted.

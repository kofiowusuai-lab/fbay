# Setting up FBay on a new machine

Everything below is required. The tool drives real browser sessions and a
vision model, so there is no way to skip the credential steps.

## 1. Prerequisites

- **macOS or Linux**, Node 22+
- A **secondary Facebook account** (see Account safety in the README — do not
  use your main one)
- An **eBay account** on the marketplace you intend to sell on

```bash
git clone <this repo> fbay && cd fbay
npm install
npx playwright install chromium
cd dashboard && npm install && npm run build && cd ..
ln -sf "$PWD/fbay" ~/bin/fbay        # so `fbay` works from anywhere
```

## 2. Credentials

```bash
cp .env.example .env
```

| Variable | Required | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` | one of them | console.anthropic.com / platform.openai.com |
| `EBAY_APP_ID`, `EBAY_CERT_ID` | optional | developer.ebay.com → Production keyset, **enable OAuth** |
| `TELEGRAM_BOT_TOKEN` | for alerts | @BotFather |
| `TELEGRAM_CHAT_ID` | for alerts | `fbay telegram-setup` fills this in |

**Neither API key?** The Codex CLI works using a ChatGPT subscription instead —
install it, run `codex login`, and FBay detects it. Slower (~20s per listing
versus ~3s) so it suits ad-hoc use better than continuous scanning.

**eBay keys are optional.** They supply the active-listing count used for
sell-through. Without them FBay reads that from the browser session instead.
If the token request returns `unauthorized_client`, OAuth is not enabled on the
keyset — that is the fix, not a wait.

## 3. Sessions and location

```bash
fbay login            # Facebook, in FBay's own browser profile
fbay ebay-login       # eBay, on the domain matching config.marketplace
fbay fb-location      # set Marketplace location — see the warning below
fbay telegram-setup   # link your chat
fbay doctor           # every row must be ok
```

> ⚠️ **Facebook's Marketplace location is account state, not a URL parameter.**
> The city in a search URL is a *request*: if your account's location is set
> elsewhere, Facebook silently serves listings from there instead. Only major
> cities are valid slugs — smaller towns fall back to the account location
> without erroring. Set `location.country` in `config.json` so foreign listings
> are rejected before they cost a model call.

## 4. Configure for your market

`config.json` overrides the defaults in `src/config.mjs`. The values that matter:

| Key | Meaning |
|---|---|
| `currency`, `marketplace` | `GBP`/`EBAY_GB` or `USD`/`EBAY_US`. **Not a currency conversion** — a different marketplace is a different market with different sold prices. |
| `economics.sellerType` | `private` or `business`. UK private sellers pay **zero** eBay selling fees; getting this wrong misprices every deal by ~13%. |
| `thresholds.maxAskCents` | Cap on a single buy. Keep it well under a quarter of your working capital. |
| `thresholds.minSellThrough` | The gate that protects you from unsellable stock. |
| `location.country` | `GB`/`US`. Rejects foreign listings. |

Then add watches:

```bash
fbay watch add --name tools --city london --query "dewalt" --max 100 --radius 120
fbay watch add --name gt-tools --source gumtree --city london --query "dewalt" --max 100
```

## 5. Run it

```bash
fbay install    # launchd service: starts at login, restarts on crash
fbay status     # is it alive, what has it found
```

Dashboard at http://localhost:3737.

## What is NOT in this repo

By design — all machine-local:

- `.env` — credentials
- `fb-profile/`, `ebay-profile/`, `gumtree-profile/` — browser sessions
- `data/fbay.db` — listings, comps, your purchase history
- `*.log`, `*.plist`

A collaborator cloning this gets the code and needs their own accounts. There is
no shared state, and no way to inherit someone else's sessions.

## Verifying the install

```bash
node --test test/*.test.mjs     # should be all green, no network required
fbay comps "dewalt dcd796"      # live check: real sold prices in your currency
```

If `fbay comps` returns a currency you did not configure, stop. eBay picks
display currency from your exit IP, and a mismatched currency will misprice
everything. Sign into an account on the target marketplace.

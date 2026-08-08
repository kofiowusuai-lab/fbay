import Link from 'next/link'
import { listDeals, statusCounts, money, pct } from '../lib/db'

export const dynamic = 'force-dynamic'

const TABS = ['alerted', 'pursuing', 'bought', 'passed', 'needs_review']

export default async function Home ({ searchParams }) {
  const sp = await searchParams
  const status = sp?.status ?? 'alerted'

  let deals = []
  let counts = {}
  try {
    deals = listDeals({ status })
    counts = Object.fromEntries(statusCounts().map((r) => [r.status, r.n]))
  } catch (e) {
    return (
      <>
        <h1>FBay</h1>
        <div className="err">{e.message}</div>
      </>
    )
  }

  return (
    <>
      <h1>FBay</h1>
      <div className="sub">Marketplace buys worth flipping, ranked by expected net</div>

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t} className="tab" data-on={t === status ? '1' : '0'} href={`/?status=${t}`}>
            {t.replace('_', ' ')} {counts[t] ? `(${counts[t]})` : ''}
          </Link>
        ))}
      </div>

      {deals.length === 0 && (
        <div className="meta">Nothing with status “{status}”. Run <code>fbay run</code> from the project root.</div>
      )}

      {deals.map((d) => {
        const img = d.image_urls ? JSON.parse(d.image_urls)[0] : null
        return (
          <Link key={d.id} className="card" href={`/deal/${d.id}`}>
            {img ? <img className="thumb" src={img} alt="" /> : <div className="thumb" />}
            <div>
              <div className="title">{d.title}</div>
              <div className="meta">
                asking {money(d.ask_cents)} · sells for {money(d.gross_cents)} · {d.city ?? 'unknown location'}
              </div>
              {d.error && <div className="reject">{d.error}</div>}
            </div>
            <div className="nums">
              <div className="offer">{money(d.breakeven_buy_cents)}</div>
              <div className="net" data-neg={d.net_profit_cents < 0 ? '1' : '0'}>
                net {money(d.net_profit_cents)} · {pct(d.roi)}
              </div>
              <div className="meta">score {d.score?.toFixed(2) ?? '—'}</div>
            </div>
          </Link>
        )
      })}
    </>
  )
}

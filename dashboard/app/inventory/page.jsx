import Link from 'next/link'
import { inventory, inventoryTotals, realisedNet, money, pct } from '../../lib/db'
import RecordButton from './RecordButton'

export const dynamic = 'force-dynamic'

const days = (t) => (t == null ? null : Math.floor((Date.now() - t) / 86400000))

export default function Inventory () {
  let rows = []
  try { rows = inventory() } catch (e) { return <div className="err">{e.message}</div> }
  const t = inventoryTotals(rows)

  return (
    <>
      <Link className="meta" href="/">← deals</Link>
      <h1 style={{ marginTop: 12 }}>Inventory</h1>
      <div className="sub">What you bought, what it cost, and what came back</div>

      <div className="grid">
        <div className="stat">capital tied up<b style={{ color: t.tiedUpCents ? 'var(--accent)' : undefined }}>{money(t.tiedUpCents)}</b></div>
        <div className="stat">unsold<b>{t.open}</b></div>
        <div className="stat">flips completed<b>{t.sold}</b></div>
        <div className="stat">realised profit<b style={{ color: t.netCents >= 0 ? 'var(--good)' : 'var(--bad)' }}>{money(t.netCents)}</b></div>
        <div className="stat">return on capital<b>{t.deployedCents ? pct(t.netCents / t.deployedCents) : '—'}</b></div>
      </div>

      {rows.length === 0 && (
        <div className="meta">
          Nothing bought yet. When you buy something the bot found, open the deal and
          record what you paid — or run <code>fbay bought &lt;id&gt; &lt;price&gt;</code>.
        </div>
      )}

      <table>
        <thead>
          <tr><th>item</th><th>paid</th><th>listed</th><th>sold</th><th>net</th><th>held</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const net = realisedNet(r)
            const stale = r.sold_cents == null && days(r.listed_at) > 21
            return (
              <tr key={r.id}>
                <td>
                  <a href={r.url} target="_blank" rel="noreferrer">{(r.title ?? '').slice(0, 44)}</a>
                  <div className="meta">{[r.brand, r.model].filter(Boolean).join(' ')}</div>
                </td>
                <td>{money(r.bought_cents)}</td>
                <td>{r.listed_cents == null
                  ? <RecordButton dealId={r.deal_id} field="listed" label="+ listed" suggested={(r.gross_cents / 100).toFixed(2)} />
                  : money(r.listed_cents)}</td>
                <td>{r.sold_cents == null
                  ? <RecordButton dealId={r.deal_id} field="sold" label="+ sold" suggested={((r.listed_cents ?? r.gross_cents) / 100).toFixed(2)} />
                  : money(r.sold_cents)}</td>
                <td style={{ color: net == null ? undefined : net >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                  {net == null ? '—' : money(net)}
                  {net != null && r.net_profit_cents != null && (
                    <div className="meta">est {money(r.net_profit_cents)}</div>
                  )}
                </td>
                <td className={stale ? 'reject' : 'meta'}>
                  {r.sold_cents != null
                    ? `${Math.round((r.sold_at - r.bought_at) / 86400000)}d`
                    : `${days(r.bought_at)}d${stale ? ' — not moving' : ''}`}
                </td>
                <td className="meta">#{r.deal_id}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {t.open > 0 && (
        <p className="meta" style={{ marginTop: 20 }}>
          Unsold stock is not profit. {money(t.tiedUpCents)} is currently unavailable to buy the next deal.
        </p>
      )}
    </>
  )
}

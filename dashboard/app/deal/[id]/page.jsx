import Link from 'next/link'
import { getDeal, getIdentity, getComps, getCompSetRow, money, pct } from '../../../lib/db'
import StatusButtons from './StatusButtons'

export const dynamic = 'force-dynamic'

export default async function DealPage ({ params }) {
  const { id } = await params
  const d = getDeal(Number(id))
  if (!d) return <div className="err">No such deal.</div>

  const identity = d.identity_key ? getIdentity(d.identity_key) : null
  const cs = d.compset_id ? getCompSetRow(d.compset_id) : null
  const comps = d.compset_id ? getComps(d.compset_id) : []
  const images = d.image_urls ? JSON.parse(d.image_urls) : []
  const rejections = d.rejections ? JSON.parse(d.rejections) : []
  const included = comps.filter((c) => c.included)

  return (
    <>
      <Link className="meta" href="/">← back</Link>
      <h1 style={{ marginTop: 12 }}>{d.title}</h1>
      <div className="sub">
        {identity
          ? `${[identity.brand, identity.model, identity.variant, identity.capacity].filter(Boolean).join(' ')} · ${identity.condition} · identified ${pct(identity.identity_confidence)} sure`
          : 'not identified'}
      </div>

      {images.length > 0 && (
        <div className="shots">
          {images.map((src) => <img key={src} src={src} alt="" />)}
        </div>
      )}

      <div className="grid">
        <div className="stat">offer up to<b style={{ color: 'var(--accent)' }}>{money(d.breakeven_buy_cents)}</b></div>
        <div className="stat">seller asks<b>{money(d.ask_cents)}</b></div>
        <div className="stat">sells for<b>{money(d.gross_cents)}</b></div>
        <div className="stat">net at ask<b style={{ color: d.net_profit_cents >= 0 ? 'var(--good)' : 'var(--bad)' }}>{money(d.net_profit_cents)}</b></div>
        <div className="stat">roi<b>{pct(d.roi)}</b></div>
        <div className="stat">sell-through<b>{cs ? pct(cs.sell_through) : '—'}</b></div>
        <div className="stat">active listings<b>{cs?.active_count ?? '—'}</b></div>
        <div className="stat">confidence<b>{pct(d.confidence)}</b></div>
      </div>

      {d.error && <div className="err">{d.error}</div>}

      {rejections.length > 0 && (
        <>
          <h3>Why this was not alerted</h3>
          {rejections.map((r, i) => <div key={i} className="reject">• {r.reason}</div>)}
        </>
      )}

      <StatusButtons id={d.id} current={d.status} />

      <p><a href={d.url} target="_blank" rel="noreferrer">open on Facebook →</a></p>

      {d.description && (
        <>
          <h3>Listing description</h3>
          <pre>{d.description}</pre>
        </>
      )}

      <h3>Comps used ({included.length} of {comps.length})</h3>
      <div className="meta">Struck-through rows were excluded. This is the evidence behind the valuation.</div>
      <table>
        <thead><tr><th>title</th><th>price</th><th>sold</th><th>excluded because</th></tr></thead>
        <tbody>
          {comps.map((c) => (
            <tr key={c.id} data-excluded={c.included ? '0' : '1'}>
              <td>{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : c.title}</td>
              <td>{money(c.price_cents)}</td>
              <td>{c.sold_at ? new Date(c.sold_at).toISOString().slice(0, 10) : '—'}</td>
              <td className="meta">{c.exclude_reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

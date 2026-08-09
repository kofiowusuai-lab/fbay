import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

let db = null

export function dbPath () {
  return process.env.FBAY_DB_PATH || path.join(process.cwd(), '..', 'data', 'fbay.db')
}

export function getDb () {
  if (!db) {
    const p = dbPath()
    if (!fs.existsSync(p)) {
      throw new Error(`No database at ${p}. Run \`fbay scan\` from the project root first.`)
    }
    db = new Database(p)
  }
  return db
}

export const money = (c) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`)
export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)

const DEAL_COLS = `d.*, l.title, l.price_cents ask_cents, l.url, l.image_urls, l.city, l.fb_id`

export function listDeals ({ status = 'alerted', limit = 100 } = {}) {
  return getDb().prepare(`
    SELECT ${DEAL_COLS} FROM deals d JOIN listings l ON l.id = d.listing_id
    WHERE d.status = ? ORDER BY d.score DESC LIMIT ?
  `).all(status, limit)
}

export function statusCounts () {
  return getDb().prepare('SELECT status, COUNT(*) n FROM deals GROUP BY status ORDER BY n DESC').all()
}

export function getDeal (id) {
  return getDb().prepare(`
    SELECT ${DEAL_COLS}, l.description, l.seller_name
    FROM deals d JOIN listings l ON l.id = d.listing_id WHERE d.id = ?
  `).get(id)
}

export function getIdentity (identityKey) {
  return getDb().prepare('SELECT * FROM identities WHERE identity_key = ? LIMIT 1').get(identityKey)
}

export function getComps (compsetId) {
  return getDb().prepare('SELECT * FROM comps WHERE compset_id = ? ORDER BY included DESC, price_cents').all(compsetId)
}

export function getCompSetRow (id) {
  return getDb().prepare('SELECT * FROM compsets WHERE id = ?').get(id)
}

export function setStatus (id, status) {
  getDb().prepare('UPDATE deals SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
}

export function inventory () {
  return getDb().prepare(`
    SELECT o.*, d.id deal_id, d.net_profit_cents, d.breakeven_buy_cents, d.gross_cents, d.roi,
           l.title, l.url, l.image_urls, l.city, i.brand, i.model
    FROM outcomes o
    JOIN deals d ON d.id = o.deal_id
    JOIN listings l ON l.id = d.listing_id
    LEFT JOIN identities i ON i.identity_key = d.identity_key
    ORDER BY o.sold_at IS NOT NULL, o.bought_at DESC
  `).all()
}

export function realisedNet (r) {
  if (r.sold_cents == null) return null
  return r.sold_cents - r.bought_cents - (r.postage_cents ?? 0) - (r.fees_cents ?? 0)
}

export function inventoryTotals (rows) {
  const sold = rows.filter((r) => r.sold_cents != null)
  const open = rows.filter((r) => r.sold_cents == null)
  return {
    sold: sold.length,
    open: open.length,
    tiedUpCents: open.reduce((s, r) => s + r.bought_cents, 0),
    netCents: sold.reduce((s, r) => s + realisedNet(r), 0),
    deployedCents: sold.reduce((s, r) => s + r.bought_cents, 0),
  }
}

export function setOutcome (dealId, field, cents) {
  const db = getDb()
  const row = db.prepare('SELECT id FROM outcomes WHERE deal_id = ? ORDER BY id DESC LIMIT 1').get(dealId)
  const now = Date.now()
  if (field === 'bought') {
    if (row) db.prepare('UPDATE outcomes SET bought_cents=? WHERE id=?').run(cents, row.id)
    else db.prepare('INSERT INTO outcomes (deal_id, bought_cents, bought_at) VALUES (?,?,?)').run(dealId, cents, now)
    db.prepare("UPDATE deals SET status='bought', updated_at=? WHERE id=?").run(now, dealId)
    return { ok: true }
  }
  if (!row) return { ok: false, error: 'record the purchase first' }
  if (field === 'listed') {
    db.prepare('UPDATE outcomes SET listed_cents=?, listed_at=? WHERE id=?').run(cents, now, row.id)
    db.prepare("UPDATE deals SET status='listed', updated_at=? WHERE id=?").run(now, dealId)
  } else if (field === 'sold') {
    db.prepare('UPDATE outcomes SET sold_cents=?, sold_at=? WHERE id=?').run(cents, now, row.id)
    db.prepare("UPDATE deals SET status='sold', updated_at=? WHERE id=?").run(now, dealId)
  } else return { ok: false, error: 'unknown field' }
  return { ok: true }
}

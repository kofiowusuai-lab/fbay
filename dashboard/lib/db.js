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

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function openDb (dbPath = process.env.FBAY_DB_PATH || './data/fbay.db') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  }
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL')
  const schema = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8')
  db.exec(schema)
  migrate(db)
  return db
}

/**
 * CREATE TABLE IF NOT EXISTS never alters an existing table, so a schema change
 * needs an explicit migration. compsets/comps are pure cache - derived entirely
 * from eBay and rebuilt on the next fetch - so dropping them is safe and costs
 * nothing but one refetch. Never do this to listings or deals.
 */
export function migrate (db) {
  const cols = db.prepare('PRAGMA table_info(compsets)').all()
  const sellThrough = cols.find((c) => c.name === 'sell_through')
  const hasAvailability = cols.some((c) => c.name === 'active_count_available')

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name)
  if (!tables.includes('outcomes')) {
    db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'))
  } else {
    // Additive columns only - outcomes hold real money records and must never
    // be rebuilt the way the derived comp caches are.
    const wcols = db.prepare('PRAGMA table_info(watches)').all().map((c) => c.name)
    if (!wcols.includes('source')) db.exec("ALTER TABLE watches ADD COLUMN source TEXT NOT NULL DEFAULT 'facebook'")
    const cols = db.prepare('PRAGMA table_info(outcomes)').all().map((c) => c.name)
    if (!cols.includes('listed_cents')) db.exec('ALTER TABLE outcomes ADD COLUMN listed_cents INTEGER')
    if (!cols.includes('listed_at')) db.exec('ALTER TABLE outcomes ADD COLUMN listed_at INTEGER')
  }

  if (sellThrough && (sellThrough.notnull === 1 || !hasAvailability)) {
    const schema = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8')
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('DROP TABLE IF EXISTS comps; DROP TABLE IF EXISTS compsets;')
    db.exec(schema)
    db.exec('PRAGMA foreign_keys = ON')
    return { migrated: true, rebuilt: ['compsets', 'comps'] }
  }
  return { migrated: false, rebuilt: [] }
}

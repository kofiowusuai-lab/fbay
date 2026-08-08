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
  return db
}

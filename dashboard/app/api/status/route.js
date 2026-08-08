import { setStatus } from '../../../lib/db'

const ALLOWED = new Set(['new', 'alerted', 'reviewing', 'pursuing', 'bought', 'passed', 'expired', 'needs_review'])

export async function POST (req) {
  const { id, status } = await req.json()
  if (!ALLOWED.has(status)) {
    return Response.json({ ok: false, error: 'invalid status' }, { status: 400 })
  }
  setStatus(Number(id), status)
  return Response.json({ ok: true })
}

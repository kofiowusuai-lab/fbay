import { setOutcome } from '../../../lib/db'

const FIELDS = new Set(['bought', 'listed', 'sold'])

export async function POST (req) {
  const { dealId, field, amount } = await req.json()
  if (!FIELDS.has(field)) return Response.json({ ok: false, error: 'invalid field' }, { status: 400 })
  const cents = Math.round(Number(amount) * 100)
  if (!Number.isFinite(cents) || cents < 0) return Response.json({ ok: false, error: 'invalid amount' }, { status: 400 })
  const r = setOutcome(Number(dealId), field, cents)
  return Response.json(r, { status: r.ok ? 200 : 400 })
}

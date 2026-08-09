'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export default function RecordButton ({ dealId, field, label, suggested }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(suggested ?? '')
  const [busy, setBusy] = useState(false)

  async function save () {
    setBusy(true)
    await fetch('/api/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId, field, amount }),
    })
    setBusy(false)
    setOpen(false)
    router.refresh()
  }

  if (!open) return <button onClick={() => setOpen(true)}>{label}</button>

  return (
    <span className="rec">
      <input
        autoFocus type="number" step="0.01" value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder="£"
      />
      <button disabled={busy} onClick={save}>save</button>
      <button onClick={() => setOpen(false)}>×</button>
    </span>
  )
}

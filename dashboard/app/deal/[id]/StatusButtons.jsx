'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

const OPTIONS = ['pursuing', 'bought', 'passed', 'alerted']

export default function StatusButtons ({ id, current }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function set (status) {
    setBusy(true)
    await fetch('/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="btns">
      {OPTIONS.map((o) => (
        <button key={o} disabled={busy || o === current} onClick={() => set(o)}>
          {o === current ? `● ${o}` : o}
        </button>
      ))}
    </div>
  )
}

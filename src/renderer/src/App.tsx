import { useEffect, useState } from 'react'
import type { VaultState } from '@shared/types'

// WP0 placeholder. WP3 replaces this with the real screens.
export function App() {
  const [state, setState] = useState<VaultState | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.psafe.getState().then((res) => {
      if (!cancelled && res.ok) setState(res.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="placeholder">
      <h1>psafe3 Opener</h1>
      <p data-testid="status">{state ? `Status: ${state.status}` : 'Loading…'}</p>
    </main>
  )
}

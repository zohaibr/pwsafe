import { useEffect, useRef, useState } from 'react'
import type { AppError } from '@shared/errors'
import type { RecentFile } from '@shared/ipc'
import type { VaultState } from '@shared/types'
import { useApi } from '../api'
import { ErrorAlert } from '../components/Feedback'
import { Icon } from '../components/Icons'

/** No file open: choose one (native dialog) or a recent file. */
export function StartScreen(props: { onState: (s: VaultState) => void }) {
  const api = useApi()
  const [recent, setRecent] = useState<RecentFile[]>([])
  const [error, setError] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)
  const openRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    void api.listRecentFiles().then((r) => {
      // No recent list is not an error worth showing on the first screen.
      if (live && r.ok) setRecent(r.value)
    })
    openRef.current?.focus()
    return () => {
      live = false
    }
  }, [api])

  const afterChoose = async (r: Awaited<ReturnType<typeof api.chooseFile>>) => {
    if (!r.ok) {
      setError(r.error)
      return
    }
    if (r.value === null) return
    const s = await api.getState()
    if (s.ok) props.onState(s.value)
  }

  const run = async (fn: () => ReturnType<typeof api.chooseFile>) => {
    setBusy(true)
    setError(null)
    try {
      await afterChoose(await fn())
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="start" aria-labelledby="start-title">
      <div className="start-card">
        <div className="brand-mark" aria-hidden="true">
          <Icon name="shield" size={28} />
        </div>
        <h1 id="start-title">psafe3 Opener</h1>
        <p className="muted">
          Open a Password Safe V3 (.psafe3) file. Everything stays on this computer.
        </p>
        <button
          ref={openRef}
          type="button"
          className="button primary large"
          disabled={busy}
          onClick={() => void run(() => api.chooseFile())}
        >
          <Icon name="folder" /> Open a file…
        </button>
        {error && <ErrorAlert error={error} />}
        {recent.length > 0 && (
          <section className="recent" aria-labelledby="recent-title">
            <h2 id="recent-title">Recent files</h2>
            <ul>
              {recent.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className="recent-item"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await api.chooseRecentFile(f.id)
                        return r
                      })
                    }
                  >
                    <Icon name="file" />
                    <span className="recent-name">{f.fileName}</span>
                    <span className="recent-folder">{f.folder}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  )
}

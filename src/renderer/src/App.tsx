import { useEffect, useRef, useState } from 'react'
import type { VaultState } from '@shared/types'
import { useApi } from './api'
import { QuitWhileLockedDialog } from './dialogs/SimpleDialogs'
import { StartScreen } from './screens/StartScreen'
import { UnlockScreen } from './screens/UnlockScreen'
import { VaultScreen, type CloseRequest } from './screens/VaultScreen'

const ACTIVITY_THROTTLE_MS = 5_000

/**
 * Top level: one screen per vault status. When the vault is not open, VaultScreen is unmounted,
 * so no entry data or revealed value survives a lock (§B2, §A4.8).
 */
export function App() {
  const api = useApi()
  const [state, setState] = useState<VaultState | null>(null)
  const [closeRequest, setCloseRequest] = useState<CloseRequest | null>(null)
  const stateRef = useRef<VaultState | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    let live = true
    const offState = api.onStateChanged((s) => setState(s))
    void api.getState().then((r) => {
      if (live && r.ok) setState((prev) => prev ?? r.value)
    })
    const offClose = api.onCloseRequested((reason) => {
      const s = stateRef.current
      // Nothing to lose: let main go ahead.
      if (!s || s.dirtyCount === 0) {
        void api.respondToClose('discard')
        return
      }
      setCloseRequest({ reason, saveNow: false })
    })
    return () => {
      live = false
      offState()
      offClose()
    }
  }, [api])

  // Idle timer input (main owns the timer). Throttled.
  useEffect(() => {
    let last = 0
    const onActivity = () => {
      const now = Date.now()
      if (now - last < ACTIVITY_THROTTLE_MS) return
      last = now
      api.reportActivity()
    }
    window.addEventListener('keydown', onActivity, true)
    window.addEventListener('pointerdown', onActivity, true)
    return () => {
      window.removeEventListener('keydown', onActivity, true)
      window.removeEventListener('pointerdown', onActivity, true)
    }
  }, [api])

  const answerClose = (choice: 'save' | 'discard' | 'cancel') => {
    setCloseRequest(null)
    void api.respondToClose(choice)
  }

  const status = state?.status
  const lockedWithCloseRequest =
    closeRequest !== null &&
    !closeRequest.saveNow &&
    (status === 'locked' || status === 'unlocking')

  return (
    <>
      <p data-testid="status" className="visually-hidden">
        {state ? `Status: ${state.status}` : 'Loading…'}
      </p>
      {state === null ? null : state.status === 'no-file' ? (
        <StartScreen onState={setState} />
      ) : state.status === 'open' ? (
        <VaultScreen
          state={state}
          onState={setState}
          closeRequest={closeRequest}
          onCloseHandled={() => setCloseRequest(null)}
        />
      ) : (
        <UnlockScreen
          state={state}
          onState={setState}
          saveBeforeQuit={closeRequest?.saveNow === true}
          onCancelQuitSave={() => answerClose('cancel')}
        />
      )}
      {lockedWithCloseRequest && state && (
        <QuitWhileLockedDialog
          dirtyCount={state.dirtyCount}
          reason={closeRequest.reason}
          onUnlockAndSave={() => setCloseRequest({ ...closeRequest, saveNow: true })}
          onQuitWithoutSaving={() => answerClose('discard')}
          onCancel={() => answerClose('cancel')}
        />
      )}
    </>
  )
}

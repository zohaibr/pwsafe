// @vitest-environment jsdom
// Which API the renderer uses, and the first screen against the WP0 stub bridge.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_MESSAGES, fail, ok } from '@shared/errors'
import type { PsafeApi } from '@shared/ipc'
import { ApiProvider } from '../api'
import { App } from '../App'
import { DEFAULT_GENERATOR } from '../defaults'
import { generate, selectApi, shouldUseMock } from '../selectApi'
import { cleanup, flush } from './harness'

afterEach(async () => {
  vi.unstubAllEnvs()
  Reflect.deleteProperty(window, 'psafe')
  await cleanup()
})

/** Mirrors the WP0 main-process stub: getState works, everything else is "Not implemented yet". */
function wp0StubBridge(): PsafeApi {
  const notYet = () =>
    Promise.resolve(fail('IO_ERROR', DEFAULT_MESSAGES.IO_ERROR, 'Not implemented yet'))
  return new Proxy({} as PsafeApi, {
    get: (_t, key) => {
      if (key === 'getState')
        return () => Promise.resolve(ok({ status: 'no-file', dirtyCount: 0, banners: [] }))
      if (key === 'onStateChanged' || key === 'onCloseRequested') return () => () => {}
      if (key === 'reportActivity') return () => {}
      return notYet
    },
  })
}

describe('selectApi', () => {
  it('uses the mock under Vitest', async () => {
    expect(shouldUseMock()).toBe(true)
    const choice = await selectApi()
    expect(choice.mockControls).toBeDefined()
    const recent = await choice.api.listRecentFiles()
    expect(recent.ok && recent.value.length).toBeGreaterThan(0)
  })

  it('uses window.psafe when not in a mock build', async () => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('VITE_PSAFE_MOCK', '')
    expect(shouldUseMock()).toBe(false)
    const bridge = wp0StubBridge()
    Object.defineProperty(window, 'psafe', { configurable: true, value: bridge })
    const choice = await selectApi()
    expect(choice.api).toBe(bridge)
    expect(choice.mockControls).toBeUndefined()
  })

  it('VITE_PSAFE_MOCK=1 selects the mock', () => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('VITE_PSAFE_MOCK', '1')
    expect(shouldUseMock()).toBe(true)
  })

  it('the generator is the shared WP4 one over crypto.getRandomValues', () => {
    const r = generate(DEFAULT_GENERATOR)
    expect(r.ok && r.value.length).toBe(DEFAULT_GENERATOR.length)
  })
})

describe('first screen against the WP0 stub bridge (what the e2e smoke test sees)', () => {
  it('shows the heading and "Status: no-file", and no error for the missing recent list', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <ApiProvider api={wp0StubBridge()} generate={generate}>
          <App />
        </ApiProvider>,
      ),
    )
    await flush()
    expect(container.querySelector('h1')?.textContent).toBe('psafe3 Opener')
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('Status: no-file')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => root.unmount())
  })
})

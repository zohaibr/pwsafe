import { byteSourceFromFill, generatePassword } from '@shared/generator'
import type { GeneratePassword, RendererApi } from './api'

export interface ApiChoice {
  api: RendererApi
  generate: GeneratePassword
  /** Present only with the mock, so scripts can drive scenarios (window.__psafeMock). */
  mockControls?: unknown
}

/** True in dev/test builds that asked for the mock (VITE_PSAFE_MOCK=1) and under Vitest. */
export const shouldUseMock = (): boolean =>
  import.meta.env.VITE_PSAFE_MOCK === '1' || import.meta.env.VITEST === 'true'

const randomBytes = byteSourceFromFill((buf) => crypto.getRandomValues(buf))

/** The shared generator (WP4) fed by the renderer's CSPRNG. */
export const generate: GeneratePassword = (options) => generatePassword(options, randomBytes)

/**
 * Picks the API: the mock when `shouldUseMock()`, otherwise the preload bridge `window.psafe`.
 * The mock module is only imported on that branch, so a normal build does not bundle it.
 */
export async function selectApi(): Promise<ApiChoice> {
  if (shouldUseMock()) {
    const { createMockApi } = await import('../mocks/mockApi')
    const { api, controls } = createMockApi({ latencyMs: 120 })
    return { api, generate, mockControls: controls }
  }
  return { api: window.psafe, generate }
}

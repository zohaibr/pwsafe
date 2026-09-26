/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' makes a dev or test build use the in-memory mock API (src/renderer/mocks). */
  readonly VITE_PSAFE_MOCK?: string
  /** Set by Vitest. */
  readonly VITEST?: string
}

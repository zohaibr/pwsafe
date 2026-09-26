import type { PsafeApi } from '../shared/ipc'

declare global {
  interface Window {
    psafe: PsafeApi
  }
}

export {}

import { createContext, useContext, type ReactNode } from 'react'
import type { PsafeApi } from '@shared/ipc'
import type { Result } from '@shared/errors'
import type { GeneratorOptions, VaultState } from '@shared/types'

/** What the user picked in the "file is open in another app" dialog (§A6). */
export type LockChoice = 'read-only' | 'remove-lock'

/**
 * Calls the UI needs that `PsafeApi` does not have yet. They are optional: when the real bridge
 * lacks them the UI hides the matching buttons. Requested as a contract change for WP7.
 */
export interface PendingApiAdditions {
  /** Unlock a file whose `.plk` is held by someone else, read-only or after removing the lock. */
  unlockWithLockChoice(password: string, choice: LockChoice): Promise<Result<VaultState>>
}

export type RendererApi = PsafeApi & Partial<PendingApiAdditions>

/**
 * Password generator used by the editor: `generatePassword` from src/shared/generator.ts with the
 * renderer's CSPRNG in the app; injectable so tests can script it.
 */
export type GeneratePassword = (options: GeneratorOptions) => Result<string>

const ApiContext = createContext<RendererApi | null>(null)
const GeneratorContext = createContext<GeneratePassword | null>(null)

export function ApiProvider(props: {
  api: RendererApi
  generate: GeneratePassword
  children: ReactNode
}) {
  return (
    <ApiContext.Provider value={props.api}>
      <GeneratorContext.Provider value={props.generate}>{props.children}</GeneratorContext.Provider>
    </ApiContext.Provider>
  )
}

export function useApi(): RendererApi {
  const api = useContext(ApiContext)
  if (!api) throw new Error('ApiProvider missing')
  return api
}

export function useGenerator(): GeneratePassword {
  const generate = useContext(GeneratorContext)
  if (!generate) throw new Error('ApiProvider missing')
  return generate
}

import { createContext, useContext, type ReactNode } from 'react'
import type { PsafeApi } from '@shared/ipc'
import type { Result } from '@shared/errors'
import type { GeneratorOptions } from '@shared/types'

/** The API the UI runs against: the preload bridge `window.psafe`, or the mock in tests. */
export type RendererApi = PsafeApi

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

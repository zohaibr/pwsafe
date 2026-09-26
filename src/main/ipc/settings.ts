// App settings (§B1, §B2), stored as JSON in the app's user-data folder. No secrets live here.
import { join } from 'node:path'
import { GENERATOR_DEFAULT_LENGTH, IDLE_LOCK_DEFAULT_MIN } from '../../shared/limits'
import type { Settings } from '../../shared/types'
import { readJson, writeJsonAtomic } from './jsonFile'
import { settings as validateSettings } from './validate'

export const DEFAULT_SETTINGS: Settings = {
  idleLockMinutes: IDLE_LOCK_DEFAULT_MIN,
  lockOnMinimize: false,
  generator: {
    length: GENERATOR_DEFAULT_LENGTH,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    avoidLookAlikes: false,
    requireEachSelected: true,
  },
}

export const SETTINGS_FILE = 'settings.json'

export class SettingsStore {
  private current: Settings = structuredClone(DEFAULT_SETTINGS)
  private readonly path: string

  constructor(
    dir: string,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.path = join(dir, SETTINGS_FILE)
  }

  /** Reads the file; a missing or invalid file gives the defaults. */
  async load(): Promise<Settings> {
    const raw = await readJson(this.path)
    if (raw !== undefined) {
      try {
        this.current = validateSettings(raw)
      } catch {
        this.log('settings: stored settings are invalid; using defaults')
        this.current = structuredClone(DEFAULT_SETTINGS)
      }
    }
    return this.get()
  }

  get(): Settings {
    return structuredClone(this.current)
  }

  /** Stores already-validated settings. */
  async set(next: Settings): Promise<Settings> {
    await writeJsonAtomic(this.path, next)
    this.current = structuredClone(next)
    return this.get()
  }
}

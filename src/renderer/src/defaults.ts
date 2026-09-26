import { GENERATOR_DEFAULT_LENGTH } from '@shared/limits'
import type { GeneratorOptions } from '@shared/types'

/** §B1 defaults, used until the saved settings arrive. */
export const DEFAULT_GENERATOR: GeneratorOptions = {
  length: GENERATOR_DEFAULT_LENGTH,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  avoidLookAlikes: false,
  requireEachSelected: true,
}

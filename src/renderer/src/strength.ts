// Strength label for the generator (§B1), computed from the options shown, not from a sample.
import { alphabetFor } from '@shared/generator'
import type { GeneratorOptions } from '@shared/types'

export type StrengthLabel = 'Weak' | 'Fair' | 'Strong' | 'Very strong'

/** Entropy in bits of a password drawn uniformly with these options. */
export function entropyBits(options: GeneratorOptions): number {
  const size = alphabetFor(options).length
  return size <= 1 ? 0 : options.length * Math.log2(size)
}

export function strengthLabel(options: GeneratorOptions): StrengthLabel {
  const bits = entropyBits(options)
  if (bits < 50) return 'Weak'
  if (bits < 75) return 'Fair'
  if (bits < 100) return 'Strong'
  return 'Very strong'
}

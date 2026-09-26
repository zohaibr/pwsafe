// Password generator (docs/execution-plan.md §B1, WP4).
// Pure: no Node, DOM or Electron imports. Randomness comes from an injected byte source, so the
// main process can pass crypto.randomBytes, the renderer crypto.getRandomValues (via
// byteSourceFromFill), and tests a scripted source.
import { ErrorCode, fail, ok, type Result } from './errors'
import { GENERATOR_MAX_LENGTH, GENERATOR_MIN_LENGTH } from './limits'
import type { GeneratorOptions } from './types'

/** Returns exactly `n` random bytes. */
export type ByteSource = (n: number) => Uint8Array

export const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
export const DIGITS = '0123456789'
/** The 32 printable ASCII punctuation characters (no space). With the three sets above: 94. */
export const SYMBOLS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
/** Characters removed when "avoid look-alikes" is on. */
export const LOOK_ALIKES = 'O0Il1|'

/** Upper bound on candidates when "at least one of each selected type" keeps discarding. */
const MAX_CANDIDATES = 10_000
/** Upper bound on byte requests for one candidate (a working CSPRNG never gets close). */
const MAX_BYTE_ROUNDS = 10_000
/** crypto.getRandomValues refuses more than 65,536 bytes per call. */
const MAX_FILL_BYTES = 65_536

/**
 * The selected character sets, in a fixed order (upper, lower, digits, symbols), with
 * look-alikes removed when that option is on. Empty sets are left out.
 */
export function selectedSets(options: GeneratorOptions): string[] {
  const sets: string[] = []
  if (options.upper) sets.push(UPPERCASE)
  if (options.lower) sets.push(LOWERCASE)
  if (options.digits) sets.push(DIGITS)
  if (options.symbols) sets.push(SYMBOLS)
  return sets
    .map((s) =>
      options.avoidLookAlikes ? [...s].filter((c) => !LOOK_ALIKES.includes(c)).join('') : s,
    )
    .filter((s) => s.length > 0)
}

/** The full alphabet a password is drawn from: the selected sets concatenated in order. */
export function alphabetFor(options: GeneratorOptions): string {
  return selectedSets(options).join('')
}

/**
 * Generates a password.
 *
 * - Each character is `alphabet[b % n]` for a random byte `b`; bytes at or above the largest
 *   multiple of the alphabet size `n` (256 - 256 % n) are rejected and redrawn, so every
 *   character is equally likely (no modulo bias).
 * - With `requireEachSelected`, a candidate that lacks any selected set is discarded whole and
 *   a new one drawn. Discarding (rather than patching in a character) keeps every valid
 *   password equally likely (§B1).
 * - Bytes are consumed strictly in order: a candidate first asks for `length` bytes, then for
 *   as many more as it still needs after rejections.
 */
export function generatePassword(
  options: GeneratorOptions,
  randomBytes: ByteSource,
): Result<string> {
  const sets = selectedSets(options)
  if (sets.length === 0) {
    return fail(ErrorCode.INVALID_ARGUMENT, 'Choose at least one character type.')
  }
  const { length } = options
  if (!Number.isInteger(length) || length < GENERATOR_MIN_LENGTH || length > GENERATOR_MAX_LENGTH) {
    return fail(
      ErrorCode.INVALID_ARGUMENT,
      `Password length must be a whole number from ${GENERATOR_MIN_LENGTH} to ${GENERATOR_MAX_LENGTH}.`,
    )
  }
  const alphabet = sets.join('')
  const n = alphabet.length
  const limit = 256 - (256 % n)

  for (let candidate = 0; candidate < MAX_CANDIDATES; candidate++) {
    const chars: string[] = []
    for (let round = 0; chars.length < length; round++) {
      if (round >= MAX_BYTE_ROUNDS) return byteSourceFailure()
      const want = length - chars.length
      const bytes = randomBytes(want)
      if (!(bytes instanceof Uint8Array) || bytes.length !== want) return byteSourceFailure()
      for (const b of bytes) {
        if (b < limit) chars.push(alphabet[b % n] as string)
      }
    }
    const password = chars.join('')
    if (!options.requireEachSelected || sets.every((s) => containsAny(password, s))) {
      return ok(password)
    }
  }
  return byteSourceFailure()
}

function containsAny(text: string, set: string): boolean {
  for (const c of text) if (set.includes(c)) return true
  return false
}

function byteSourceFailure(): Result<string> {
  return fail(
    ErrorCode.INVALID_ARGUMENT,
    'Could not generate a password. Please try again.',
    'random byte source misbehaved',
  )
}

/**
 * Adapts a fill-in-place random function (for example `crypto.getRandomValues` in the renderer,
 * or `crypto.randomFillSync` in main) into a ByteSource. Large requests are split into
 * 65,536-byte calls because getRandomValues refuses larger ones. `crypto.randomBytes` from
 * Node already returns a Uint8Array and can be passed to generatePassword directly.
 */
export function byteSourceFromFill(fill: (buf: Uint8Array) => unknown): ByteSource {
  return (n: number) => {
    const out = new Uint8Array(n)
    for (let off = 0; off < n; off += MAX_FILL_BYTES) {
      fill(out.subarray(off, Math.min(n, off + MAX_FILL_BYTES)))
    }
    return out
  }
}

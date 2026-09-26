import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StretchCancelledError, stretchKeyInWorker, stretchKeySync } from './stretch'
import { PYPWSAFE_DIR, PYPWSAFE_FILES, PYPWSAFE_PASSWORD, hasPypwsafe } from './testing/fixtures'

const pw = new TextEncoder().encode('pässwörd')
const salt = new Uint8Array(32).map((_, i) => i)

describe('key stretching (§2.3)', () => {
  it('matches the spec definition computed independently', () => {
    let x = createHash('sha256').update(pw).update(salt).digest()
    for (let i = 0; i < 3000; i++) x = createHash('sha256').update(x).digest()
    expect(Buffer.from(stretchKeySync(pw, salt, 3000))).toEqual(x)
  })

  it.skipIf(!hasPypwsafe)('reproduces H(P′) of every pypwsafe fixture', () => {
    for (const f of PYPWSAFE_FILES) {
      const file = readFileSync(join(PYPWSAFE_DIR, f))
      const p = stretchKeySync(
        Buffer.from(PYPWSAFE_PASSWORD),
        file.subarray(4, 36),
        file.readUInt32LE(36),
      )
      expect(createHash('sha256').update(p).digest().equals(file.subarray(40, 72)), f).toBe(true)
    }
  })

  it('the worker computes the same key, reports progress and does not touch the input', async () => {
    const input = new Uint8Array(pw)
    const progress: number[] = []
    const key = await stretchKeyInWorker(input, salt, 50_000, {
      onProgress: (f) => progress.push(f),
    })
    expect(Buffer.from(key)).toEqual(Buffer.from(stretchKeySync(pw, salt, 50_000)))
    expect(Buffer.from(input)).toEqual(Buffer.from(pw))
    expect(progress.length).toBeGreaterThan(1)
    expect(progress.at(-1)).toBe(1)
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!)
  })

  it('cancels promptly when the signal aborts', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const p = stretchKeyInWorker(pw, salt, 2 ** 24, { signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toBeInstanceOf(StretchCancelledError)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('rejects at once when already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      stretchKeyInWorker(pw, salt, 2 ** 24, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(StretchCancelledError)
  })
})

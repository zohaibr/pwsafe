// §A4.8 (WP9): copies of secrets the codec makes on its own are zeroed. With the default random
// source, the buffers crypto.randomBytes returned for the salt, K, L and IV are wiped once copied;
// the key-stretch worker's password copy on the main-thread side is wiped once the worker has it.
import { describe, expect, it, vi } from 'vitest'
import { createTwofish } from '../crypto/twofish/twofish'
import { FieldType, HeaderFieldType } from '../../shared/types'
import { decode, encode } from './codec'
import { encodeText } from './fields'
import { stretchKeyInWorker, stretchKeySync, type StretchFn } from './stretch'

const spy = vi.hoisted(() => ({
  random: [] as Uint8Array[],
  workerPasswords: [] as Uint8Array[],
}))

vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>()
  const randomBytes = ((n: number) => {
    const b = orig.randomBytes(n)
    spy.random.push(b)
    return b
  }) as typeof orig.randomBytes
  return { ...orig, default: { ...orig, randomBytes }, randomBytes }
})

vi.mock('node:worker_threads', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:worker_threads')>()
  class Worker extends orig.Worker {
    constructor(source: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      const data = options?.workerData as { password?: unknown } | undefined
      if (data?.password instanceof Uint8Array) spy.workerPasswords.push(data.password)
      super(source, options)
    }
  }
  return { ...orig, default: { ...orig, Worker }, Worker }
})

const PASSWORD = new TextEncoder().encode('correct horse battery staple')
const fastStretch: StretchFn = async (password, salt) => stretchKeySync(password, salt, 1)
const model = () => ({
  header: [{ type: HeaderFieldType.VERSION, data: Uint8Array.from([0x11, 0x03]) }],
  records: [
    {
      fields: [
        { type: FieldType.UUID, data: new Uint8Array(16).fill(7) },
        { type: FieldType.TITLE, data: encodeText('Bank') },
        { type: FieldType.PASSWORD, data: encodeText('s3cret') },
      ],
    },
  ],
})

describe('codec: no stray copies of K and L', () => {
  it('encode wipes the default source buffers for salt, K, L and IV, and the file still opens', async () => {
    spy.random.length = 0
    const r = await encode(model(), PASSWORD, {
      cipherFactory: createTwofish,
      stretch: fastStretch,
    })
    if (!r.ok) throw new Error(r.error.code)
    // takeRandom draws salt, K, L, IV first, in that order.
    const [salt, k, l, iv] = spy.random
    expect([salt, k, l, iv].map((b) => b?.length)).toEqual([32, 32, 32, 16])
    for (const b of [salt, k, l, iv]) expect(b!.every((x) => x === 0)).toBe(true)
    const d = await decode(r.value, PASSWORD, {
      cipherFactory: createTwofish,
      stretch: fastStretch,
    })
    expect(d.ok && d.value.records[0]!.fields[2]!.data).toEqual(encodeText('s3cret'))
  })
})

describe('key stretching worker', () => {
  it("zeroes the main-thread copy of the password it hands to the worker; P' is unchanged", async () => {
    spy.workerPasswords.length = 0
    const salt = new Uint8Array(32).fill(5)
    const p = await stretchKeyInWorker(PASSWORD, salt, 4_096)
    expect(Buffer.from(p)).toEqual(Buffer.from(stretchKeySync(PASSWORD, salt, 4_096)))
    expect(spy.workerPasswords).toHaveLength(1)
    expect(spy.workerPasswords[0]!.every((x) => x === 0)).toBe(true)
    expect(PASSWORD.every((x) => x === 0)).toBe(false)
  })
})

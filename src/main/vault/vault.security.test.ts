// §A4.8 tested boundary (WP9): the key and plaintext buffers the vault owns in the main process
// are all zero after lock and after close. Also §A4 step 1 before any read: a file over the size
// cap is refused without being loaded into memory.
//
// Every secret buffer is captured where it is handed to a dependency: the master password and P'
// at the key-stretch call, P' and K at the cipher factory, L at createHmac (mocked below), and the
// decrypted field bytes through getExportData (which shares them with the model).
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ErrorCode } from '../../shared/errors'
import { MAX_FILE_BYTES } from '../../shared/limits'
import type { BlockCipherFactory } from '../crypto/cipher'
import { createTwofish } from '../crypto/twofish/twofish'
import type { FileStat } from '../fs/types'
import { MemoryFileSystem } from '../fs/memoryFs'
import type { CodecDeps } from '../psafe3/codec'
import type { StretchFn } from '../psafe3/stretch'
import {
  encodeModel,
  makeVault,
  PASSWORD,
  seededRandom,
  smallModel,
  unwrap,
  uuidHex,
} from './testkit'

const spy = vi.hoisted(() => ({ hmacKeys: [] as Uint8Array[] }))

vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>()
  const createHmac = ((algorithm: string, key: Parameters<typeof orig.createHmac>[1]) => {
    if (key instanceof Uint8Array) spy.hmacKeys.push(key)
    return orig.createHmac(algorithm, key)
  }) as typeof orig.createHmac
  return { ...orig, default: { ...orig, createHmac }, createHmac }
})

const DB = '/v/db.psafe3'
const isZero = (b: Uint8Array) => b.every((x) => x === 0)

/** A codec that records every secret buffer it is handed or hands out. */
function instrumentedCodec() {
  const seen = {
    passwords: [] as Uint8Array[],
    pPrimes: [] as Uint8Array[],
    cipherKeys: [] as Uint8Array[],
    ciphers: [] as { disposed: boolean }[],
  }
  // One SHA-256 instead of the real loop (fast), without leaving a copy of P' behind.
  const stretch: StretchFn = async (password, salt) => {
    seen.passwords.push(password)
    const d = createHash('sha256').update(password).update(salt).digest()
    const out = new Uint8Array(d)
    d.fill(0)
    seen.pPrimes.push(out)
    return out
  }
  const cipherFactory: BlockCipherFactory = (key) => {
    seen.cipherKeys.push(key)
    const c = createTwofish(key)
    const record = { disposed: false }
    seen.ciphers.push(record)
    return {
      encryptBlock: (...a) => c.encryptBlock(...a),
      decryptBlock: (...a) => c.decryptBlock(...a),
      dispose: () => {
        record.disposed = true
        c.dispose()
      },
    }
  }
  const codec: CodecDeps = { cipherFactory, stretch, randomBytes: seededRandom('security') }
  return { codec, seen }
}

function fieldBuffers(r: {
  header: { data: Uint8Array }[]
  records: { fields: { data: Uint8Array }[] }[]
}) {
  return [...r.header.map((f) => f.data), ...r.records.flatMap((x) => x.fields.map((f) => f.data))]
}

function expectAllZero(what: string, bufs: Uint8Array[]) {
  expect(bufs.length, `${what}: nothing captured`).toBeGreaterThan(0)
  const live = bufs.filter((b) => !isZero(b)).length
  expect(live, `${what}: ${live} of ${bufs.length} buffers not zeroed`).toBe(0)
}

describe('§A4.8: owned key buffers are zero after lock', () => {
  it('after unlock, edit, save, backup preview and an auto-lock with unsaved changes', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    const { codec, seen } = instrumentedCodec()
    const vault = makeVault(fs, { codec })
    spy.hmacKeys.length = 0

    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(PASSWORD))
    const fields = fieldBuffers(unwrap(vault.getExportData()))
    // An edit (the old password bytes are replaced), a save (encode, re-parse, verify) and a
    // preview of the backup that save made (its own password copy and model).
    unwrap(await vault.saveEntry({ uuid: uuidHex(1), password: 'new-bank-secret' }))
    unwrap(await vault.save())
    const [backup] = unwrap(await vault.listBackups())
    unwrap(await vault.previewBackup(backup!.id, PASSWORD))
    // Unsaved changes, so lock re-encrypts in memory (§B3) before dropping the plaintext.
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), notes: 'unsaved note' }))
    unwrap(await vault.deleteEntry(uuidHex(2)))
    fields.push(...fieldBuffers(unwrap(vault.getExportData())))

    expect(unwrap(await vault.lock()).dirtyCount).toBe(2)

    expectAllZero('master password copies', seen.passwords)
    expectAllZero("P'", seen.pPrimes)
    expectAllZero("cipher keys (P', K)", seen.cipherKeys)
    expectAllZero('HMAC keys (L)', spy.hmacKeys)
    expectAllZero('decrypted field buffers', fields)
    expect(seen.ciphers.every((c) => c.disposed)).toBe(true)
    // Stretches: unlock, save (one shared by encode and both verifies), preview, re-encrypt.
    expect(seen.passwords).toHaveLength(4)

    // The in-memory blob was not damaged by the wipe: unlocking brings the changes back.
    expect(unwrap(await vault.unlock(PASSWORD)).dirtyCount).toBe(2)
    expect(unwrap(vault.revealPassword(uuidHex(1)))).toBe('new-bank-secret')
  })

  it('close drops the password and plaintext too', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    const { codec, seen } = instrumentedCodec()
    const vault = makeVault(fs, { codec })
    spy.hmacKeys.length = 0
    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(PASSWORD))
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), notes: 'unsaved note' }))
    const fields = fieldBuffers(unwrap(vault.getExportData()))

    unwrap(await vault.close())

    expectAllZero('master password copies', seen.passwords)
    expectAllZero("P'", seen.pPrimes)
    expectAllZero("cipher keys (P', K)", seen.cipherKeys)
    expectAllZero('HMAC keys (L)', spy.hmacKeys)
    expectAllZero('decrypted field buffers', fields)
  })

  it('the caller-owned password passed to unlock is left to the caller; the vault uses a copy', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    const { codec, seen } = instrumentedCodec()
    const vault = makeVault(fs, { codec })
    const mine = Uint8Array.from(PASSWORD)
    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(mine))
    expect(seen.passwords.every((p) => p !== mine)).toBe(true)
    expect(isZero(mine)).toBe(false)
    unwrap(await vault.lock())
    expectAllZero('master password copies', seen.passwords)
  })
})

/**
 * The memory file system, but reporting `size` for paths in `oversized` and recording reads.
 * Paths are compared resolved: the vault resolves them (on Windows '/v/x' becomes 'C:\\v\\x').
 */
class SizedFs extends MemoryFileSystem {
  readonly reads: string[] = []
  constructor(private readonly oversized: Set<string>) {
    super()
  }
  override async lstat(path: string): Promise<FileStat> {
    const st = await super.lstat(path)
    const big = [...this.oversized].some((p) => resolve(p) === resolve(path))
    return big ? { ...st, size: MAX_FILE_BYTES + 1 } : st
  }
  override async readFile(path: string): Promise<Uint8Array> {
    this.reads.push(resolve(path))
    return super.readFile(path)
  }
}

describe('§A4 step 1 before reading: files over 128 MB are not loaded', () => {
  it('unlock returns TOO_LARGE without reading the file', async () => {
    const fs = new SizedFs(new Set([DB]))
    fs.setFile(DB, await encodeModel(smallModel()))
    const vault = makeVault(fs)
    unwrap(await vault.open(DB))
    const r = await vault.unlock(PASSWORD)
    expect(r.ok || r.error.code).toBe(ErrorCode.TOO_LARGE)
    expect(fs.reads).not.toContain(resolve(DB))
    expect(vault.getState().status).toBe('locked')
  })

  it('reload from disk returns TOO_LARGE without reading, and keeps the open vault', async () => {
    const oversized = new Set<string>()
    const fs = new SizedFs(oversized)
    fs.setFile(DB, await encodeModel(smallModel()))
    const vault = makeVault(fs)
    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(PASSWORD))
    oversized.add(DB)
    fs.reads.length = 0
    const r = await vault.reloadFromDisk()
    expect(r.ok || r.error.code).toBe(ErrorCode.TOO_LARGE)
    expect(fs.reads).toEqual([])
    expect(vault.getState().status).toBe('open')
  })

  it('backup preview returns TOO_LARGE without reading the backup', async () => {
    const fs = new SizedFs(new Set([`${DB}.bak`]))
    fs.setFile(DB, await encodeModel(smallModel()))
    fs.setFile(`${DB}.bak`, await encodeModel(smallModel(), PASSWORD, { seed: 'bak' }))
    const vault = makeVault(fs)
    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(PASSWORD))
    const [backup] = unwrap(await vault.listBackups())
    const r = await vault.previewBackup(backup!.id, PASSWORD)
    expect(r.ok || r.error.code).toBe(ErrorCode.TOO_LARGE)
    expect(fs.reads).not.toContain(resolve(`${DB}.bak`))
    // Sanity: reads are recorded under the same path form (the database was read at unlock).
    expect(fs.reads).toContain(resolve(DB))
  })
})

// Downloads pypwsafe's test safes at a pinned commit into test/fixtures/pypwsafe/ (git-ignored).
// They come from a GPLv2 repository, so we fetch them at test time instead of committing them.
// Source: https://github.com/ronys/pypwsafe (authors: Paulson McIntyre, Evan Deaubl, Sean Perry,
// Rony Shapiro and contributors). Every file is checked against the SHA-256 recorded here.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PYPWSAFE_COMMIT = '05ae8a2f7de07e1606d062a0135c43ffc0b0e22c'
export const PYPWSAFE_PASSWORD = 'bogus12345'

export const FIXTURES = {
  'EmptyGroupTest.psafe3': '2da9741a766f214167707dac01095d367be21e410640a1ab2073a9388f8c67d2',
  'LastSaveUserTest.psafe3': '4f6f96662c165092fd108811776cacc2e65d994805e7c0b018ac7c83ccc9b5b1',
  'NonDefaultPrefsTest.psafe3': '0061e7a6059f3277d2b1ffec12db1d4f964b51540363c231a6decab29ca1deff',
  'RecentEntriesTest.psafe3': '0413fd7c6947c166bbd3fcdb6119070a656090db8d8b8c22b4fe78035537fad8',
  'VersionTest.psafe3': '220260da7dd42a88fbf9e5690f0135c60dd2970d1d63136ec261dc7f9b9abdd9',
  'passwordPolicyTest.psafe3': '8a67a22b70e26427e3209eca7f31a372b6a8035ca1fe4b3f2232f098e0c97e96',
  'simple.psafe3': '3c4705c07ee111eadf496343d9e3fbc5fe30b4c16448190b35b4801567a465e3',
  'unknown-record-prop-1.psafe3':
    'b74262bbf690646c3daee81caa20a46fcc404c6e802565d48492f70ba31e34c5',
}

const outDir = join(import.meta.dirname, '..', 'test', 'fixtures', 'pypwsafe')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function haveValid(file, expected) {
  try {
    return sha256(await readFile(join(outDir, file))) === expected
  } catch {
    return false
  }
}

await mkdir(outDir, { recursive: true })
for (const [file, expected] of Object.entries(FIXTURES)) {
  if (await haveValid(file, expected)) continue
  const url = `https://raw.githubusercontent.com/ronys/pypwsafe/${PYPWSAFE_COMMIT}/test_safes/${file}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const actual = sha256(buf)
  if (actual !== expected) throw new Error(`Checksum mismatch for ${file}: ${actual}`)
  await writeFile(join(outDir, file), buf)
  console.log(`fetched ${file}`)
}
console.log(`pypwsafe fixtures ready in ${outDir}`)

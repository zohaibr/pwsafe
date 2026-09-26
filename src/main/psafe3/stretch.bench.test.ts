// Opt-in benchmark for docs/benchmarks.md (§A1): PSAFE3_BENCH=1 npx vitest run stretch.bench
// Measures the shipped loop (crypto.hash, in a worker) against the plain createHash loop.
import { createHash } from 'node:crypto'
import { arch, cpus, platform } from 'node:os'
import { describe, expect, it } from 'vitest'
import { stretchKeyInWorker, stretchKeySync } from './stretch'

const ROUNDS = [262_144, 2 ** 20, 2 ** 24]
const pw = new TextEncoder().encode('benchmark-password')
const salt = new Uint8Array(32).fill(3)

function createHashLoop(iterations: number): Uint8Array {
  let x = createHash('sha256').update(pw).update(salt).digest()
  for (let i = 0; i < iterations; i++) x = createHash('sha256').update(x).digest()
  return x
}

const time = async (fn: () => unknown): Promise<number> => {
  const t = performance.now()
  await fn()
  return (performance.now() - t) / 1000
}

describe.skipIf(!process.env['PSAFE3_BENCH'])('key stretching benchmark', () => {
  it('prints timings', async () => {
    const lines = [
      `${platform()} ${arch()}, ${cpus().length} × ${cpus()[0]?.model ?? '?'}, Node ${process.versions.node}`,
      '| Rounds | Worker (shipped) | crypto.hash loop, main thread | createHash loop, main thread |',
      '| ---: | ---: | ---: | ---: |',
    ]
    for (const n of ROUNDS) {
      const worker = await time(() => stretchKeyInWorker(pw, salt, n))
      const hashLoop = await time(() => stretchKeySync(pw, salt, n))
      const createLoop = await time(() => createHashLoop(n))
      expect(Buffer.from(stretchKeySync(pw, salt, 10))).toEqual(Buffer.from(createHashLoop(10)))
      lines.push(
        `| ${n.toLocaleString('en-US')} | ${worker.toFixed(2)} s | ${hashLoop.toFixed(2)} s | ${createLoop.toFixed(2)} s |`,
      )
    }
    console.warn(lines.join('\n'))
  }, 600_000)
})

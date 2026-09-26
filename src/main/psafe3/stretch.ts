// Key stretching (format spec v3.31 §2.3, [KEYSTRETCH] §4.1):
//   X0 = SHA-256(passphrase || salt); X(i) = SHA-256(X(i-1)) for i = 1..ITER; P' = X(ITER).
// `stretchKeySync` is the reference core (used in tests and inside the worker). `stretchKeyInWorker`
// runs the same loop in a worker thread so the main process never blocks, with progress and cancel.
import { createHash, hash } from 'node:crypto'
import { Worker } from 'node:worker_threads'

export interface StretchOptions {
  /** Called with a fraction in 0..1 as the loop advances. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** Resolves to P' (32 bytes). Rejects with `StretchCancelledError` when `signal` aborts. */
export type StretchFn = (
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  options?: StretchOptions,
) => Promise<Uint8Array>

export class StretchCancelledError extends Error {
  override name = 'StretchCancelledError'
}

/** Iterations between progress reports from the worker. */
const PROGRESS_EVERY = 1 << 14

/** Synchronous reference implementation. Blocks the calling thread; use it only in tests. */
export function stretchKeySync(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Uint8Array {
  let x: Buffer = createHash('sha256').update(password).update(salt).digest()
  for (let i = 0; i < iterations; i++) {
    const next = hash('sha256', x, 'buffer')
    x.fill(0)
    x = next
  }
  return new Uint8Array(x.buffer, x.byteOffset, x.byteLength)
}

// Worker body, kept as a self-contained CommonJS string so it runs the same way under Vitest and
// in the bundled Electron main process (no separate worker entry to wire into the build).
// It must compute exactly what stretchKeySync computes; stretch.test.ts checks this.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash, hash } = require('node:crypto')
const { password, salt, iterations, every } = workerData
let x = createHash('sha256').update(password).update(salt).digest()
password.fill(0)
for (let i = 1; i <= iterations; i++) {
  const next = hash('sha256', x, 'buffer')
  x.fill(0)
  x = next
  if (i % every === 0) parentPort.postMessage({ type: 'progress', done: i })
}
const out = new Uint8Array(32)
out.set(x)
x.fill(0)
parentPort.postMessage({ type: 'done', key: out }, [out.buffer])
`

/** Runs the stretch loop in a worker thread. Cancelling terminates the worker at once. */
export const stretchKeyInWorker: StretchFn = (password, salt, iterations, options = {}) => {
  const { onProgress, signal } = options
  return new Promise<Uint8Array>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StretchCancelledError('cancelled'))
      return
    }
    // workerData is structured-cloned; the worker zeroes its copy of the password after use.
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        iterations,
        every: PROGRESS_EVERY,
      },
    })
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => {
      finish(() => reject(new StretchCancelledError('cancelled')))
      void worker.terminate()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.on(
      'message',
      (msg: { type: 'progress'; done: number } | { type: 'done'; key: Uint8Array }) => {
        if (msg.type === 'progress') {
          if (!settled) onProgress?.(msg.done / iterations)
        } else {
          finish(() => {
            onProgress?.(1)
            resolve(msg.key)
          })
          void worker.terminate()
        }
      },
    )
    worker.on('error', (err) => finish(() => reject(err)))
    worker.on('exit', (code) =>
      finish(() => reject(new Error(`key stretching worker exited early (code ${code})`))),
    )
  })
}

# Key-stretching benchmarks

Opening or saving a V3 file runs SHA-256 over the passphrase `ITER` times (format spec §2.3).
§A1 sets the budget: **unlock at 262,144 rounds in 1 s or less on an Apple Silicon Mac**, and the
release gate is the measurement on the macOS Apple Silicon CI runner, not the numbers below.

## How to measure

```sh
PSAFE3_BENCH=1 npx vitest run src/main/psafe3/stretch.bench.test.ts --silent=false
```

The test prints a Markdown table. It measures:

- **Worker (shipped):** `stretchKeyInWorker`, the code the app uses: a worker thread running the
  `crypto.hash('sha256', …)` one-shot loop, including worker start-up.
- **`crypto.hash` loop, main thread:** `stretchKeySync`, the same loop without the worker.
- **`createHash` loop, main thread:** the straightforward `createHash().update().digest()` loop,
  for comparison (this is what the §A1 planning estimates used).

## Results

### Linux cloud VM (planning numbers only)

Linux x64 cloud VM, 4 vCPU Intel Xeon @ 2.80 GHz, Node 22.22.2, measured 2026-09-26. Shared
hardware, so expect ±20 % between runs.

| Rounds | Worker (shipped) | `crypto.hash` loop, main thread | `createHash` loop, main thread |
| -----: | ---------------: | ------------------------------: | -----------------------------: |
| 262,144 | 0.62 s | 0.54 s | 0.85 s |
| 1,048,576 (2^20) | 2.58 s | 2.70 s | 3.05 s |
| 16,777,216 (2^24) | 34.5 s | 41.2 s | 57.7 s |

The one-shot `crypto.hash` loop is about 25–35 % faster than the `createHash` loop, so it is what
ships. Running it in a worker costs a few tens of milliseconds of start-up and keeps the window
responsive; progress is reported every 16,384 rounds and Cancel terminates the worker at once.

### macOS Apple Silicon CI runner (release gate)

Measured on 2026-09-26 by the `Key-stretching benchmark` step of the `Lint, test, build
(macos-latest)` CI job (PR #5): darwin arm64, 3 × Apple M1 (Virtual), Node 22.23.2.

| Rounds | Worker (shipped) | crypto.hash loop, main thread | createHash loop, main thread |
| ---: | ---: | ---: | ---: |
| 262,144 | 0.25 s | 0.30 s | 0.35 s |
| 1,048,576 | 0.70 s | 0.95 s | 1.23 s |
| 16,777,216 | 12.32 s | 13.16 s | 15.09 s |

The CI step re-runs this on every macOS build, so later numbers are in the job log.

The Electron main process runs its own bundled Node version, so a final check inside the packaged
app is worth doing once WP6 wires unlock end to end.

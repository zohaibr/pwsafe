// Thin wrapper around the pinned pwsafe-cli oracle (docs/references.md).
// The passphrase is always written to stdin, never passed as --passphrase, so it cannot leak into
// process listings or CI logs. Output that may contain secrets is never printed.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export const ORACLE_CLI = process.env['PWSAFE_CLI'] ? resolve(process.env['PWSAFE_CLI']) : ''

/** True when the oracle binary is available (CI oracle job, or a local build). */
export const hasOracle = ORACLE_CLI !== ''

export interface CliRun {
  status: number | null
  /** stderr with the CLI's harmless "Couldn't turn off/restore echo" noise removed. */
  stderr: string
}

export function runCli(args: string[], stdinLines: string[], cwd: string): CliRun {
  const res = spawnSync(ORACLE_CLI, args, {
    cwd,
    input: stdinLines.map((l) => `${l}\n`).join(''),
    encoding: 'utf8',
    env: {
      ...process.env,
      // The CLI refuses to run without a UTF-8 locale.
      LC_ALL: 'C.UTF-8',
      // Directory holding pwsafe.xsd, needed for XML import (see scripts/oracle/build-pwsafe-cli.sh).
      // The CLI reads PWS_XMLDIR and needs the trailing slash.
      PWS_XMLDIR: process.env['PWS_XMLDIR'] ?? '',
    },
    timeout: 60_000,
  })
  const stderr = (res.stderr ?? '')
    .split('\n')
    .filter((l) => !/Couldn't (turn off|restore) echo/.test(l))
    .join('\n')
  return { status: res.status, stderr }
}

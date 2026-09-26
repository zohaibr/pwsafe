// Test mode for the end-to-end tests (test/e2e). It replaces the native dialogs with fixed paths,
// points user data at a temporary folder and records what main sends to the renderer, so a test
// can drive the real app without clicking native windows.
//
// It is only honoured in an unpackaged build (`app.isPackaged === false`, i.e. `electron
// out/main/index.js`); an installed app ignores every variable below.
//
//   PSAFE_E2E=1                 turn test mode on
//   PSAFE_E2E_USER_DATA=<dir>   user-data folder (settings, recent files)
//   PSAFE_E2E_OPEN=<path>       what the Open dialog returns (unset or empty = Cancel)
//   PSAFE_E2E_SAVE_AS=<path>    what the Save As dialog returns (unset or empty = Cancel)
//   PSAFE_E2E_EXPORT=<path>     what the export Save dialog returns (unset or empty = Cancel)
//   PSAFE_E2E_IPC_SPY=1         keep every payload main sends to the renderer (invoke results and
//                               events) in memory as globalThis.__psafeIpcSpy, for the §A4.8 test.
//                               Nothing is written to disk or logged.
//
// Dialog variables are read when the dialog would open, so a test can change them in between
// (electronApp.evaluate(() => { process.env.PSAFE_E2E_OPEN = '...' })).

export interface TestMode {
  userData?: string
  ipcSpy: boolean
  /** Reads the dialog stub for `kind` now. null = Cancel. */
  dialogPath(kind: 'open' | 'saveAs' | 'export'): string | null
}

const DIALOG_VARS = {
  open: 'PSAFE_E2E_OPEN',
  saveAs: 'PSAFE_E2E_SAVE_AS',
  export: 'PSAFE_E2E_EXPORT',
} as const

export function readTestMode(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
): TestMode | undefined {
  if (isPackaged || env['PSAFE_E2E'] !== '1') return undefined
  const userData = env['PSAFE_E2E_USER_DATA']
  const mode: TestMode = {
    ipcSpy: env['PSAFE_E2E_IPC_SPY'] === '1',
    dialogPath: (kind) => {
      const p = env[DIALOG_VARS[kind]]
      return p ? p : null
    },
  }
  if (userData) mode.userData = userData
  return mode
}

export interface SpyRecord {
  channel: string
  payload: unknown
}

/** The in-memory spy list (test mode only). */
export function ipcSpyList(): SpyRecord[] {
  const g = globalThis as { __psafeIpcSpy?: SpyRecord[] }
  g.__psafeIpcSpy ??= []
  return g.__psafeIpcSpy
}

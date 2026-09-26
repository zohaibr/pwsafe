# Security review (WP9)

Review of the whole codebase at `main` 798b554 (after WP7 and WP8) against docs/execution-plan.md
§A4, §A5, §A6, §A7, §B5 and WP7, plus a dependency and license audit. Date: 2026-09-26.

**Threat model used.** The app is offline and single-user. We defend against: a malicious or
corrupted `.psafe3` file (or sidecar file) opened by the user; a compromised renderer (for
example through an HTML-injection bug), which must not reach Node, the file system or passwords
beyond what the narrow API gives; secrets lingering in main-process memory longer than needed;
data loss on save. We do not defend against malware already running as the same user (it can
read process memory or log keystrokes), or against someone with write access to the vault's
folder beyond not losing data (the `.plk` is cooperative, §A5 step 6).

## Summary of findings

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| F1 | Packaging | Electron fuses were not set: a packaged build honoured `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and loaded app code without ASAR integrity checks | Medium | **Fixed** (`electron-builder.yml` `electronFuses`), checked by `build/smoke-packaged.mjs` on every packaged build |
| F2 | Codec | With the default random source, the `crypto.randomBytes` buffers behind the salt, K, L and IV were copied and the originals left for the GC (one extra plaintext copy of K and L per encode) | Low | **Fixed** (`codec.ts`), test |
| F3 | Codec | The key-stretch worker was given a main-thread copy of the master password that was never zeroed | Low | **Fixed** (`stretch.ts`), test |
| F4 | Vault | Header save-metadata buffers replaced by a save (last saved by user/host/app/time) were dropped without being zeroed | Low (not secret, but breaks the §A4.8 "owned buffers zeroed" rule) | **Fixed** (`vault.ts`), test |
| F5 | Vault | A file over the 128 MB cap was read fully into memory before `decode` refused it (TOO_LARGE); a multi-GB file could exhaust memory or fail as IO_ERROR | Low | **Fixed** (`vault.ts`): size checked with `lstat` before unlock, reload and backup preview read; tests |
| F6 | Vault / lock file | Sidecar reads (`.plk`, rotation journal, backup hashes, backup preview/restore) did not check the file type or size; a FIFO or huge file planted next to the vault could hang or stall unlock/save | Low (needs write access to the vault's folder; denial of service only) | **Fixed** (`src/main/fs/bounded.ts`), tests |
| F7 | Renderer CSP | `img-src` allowed `data:` although nothing uses it | Info | **Fixed** (`src/renderer/index.html`): `img-src 'self'` |
| F8 | Renderer CSP | Electronegativity CSP_GLOBAL_CHECK (LOW): `script-src 'self'` | Low | Accepted, rationale below |
| F9 | Window | The page is served from `file://`, so `'self'` covers every local file URL (Electron security checklist item 18 prefers a custom protocol) | Low | Accepted for v1, v1.1 candidate |
| F10 | Clipboard | Copied values are not marked concealed/transient, so clipboard managers, macOS Universal Clipboard and Windows clipboard history may keep them; a crash before the 30 s timer leaves the value on the clipboard | Low | Open (v1.1 candidate), written up below |
| F11 | CI | GitHub Actions are pinned by major tag (`@v4`, `@v5`), not by commit SHA | Info | Open; all are first-party `actions/*` |
| F12 | Session | On Linux and Windows the default session downloaded a hunspell dictionary from `redirector.gvt1.com` at startup and when typing, although `webPreferences.spellcheck` is off; the download is made by the browser process and does not pass our `webRequest` filter (found by the WP9 E2E worker) | Medium (breaks "no network requests") | **Fixed** (`src/main/session.ts`), unit test; net-log check below |
| F13 | Packaging | Chromium's `--remote-debugging-port` switch still works in an installed app (no fuse covers it); a process that can launch the app as the user could drive the page and call its API after the user unlocks | Low (same-user attacker, outside the threat model) | Open, written up below |

No High findings. The Medium findings (F1, F12) are fixed; the Medium Electronegativity result is explained under Electronegativity.

## Tested boundaries added (§A4.8)

- `src/main/vault/vault.security.test.ts`
  - *after unlock, edit, save, backup preview and an auto-lock with unsaved changes*: captures every
    master-password copy and P' (at the stretch call), every cipher key P' and K (at the cipher
    factory), every HMAC key L (at `createHmac`), every decrypted field buffer (through
    `getExportData`), and asserts all are zero after `lock()`, that every cipher key schedule was
    disposed, and that the §B3 in-memory blob still unlocks with the changes intact.
  - *close drops the password and plaintext too*: the same after `close()`.
  - *the caller-owned password passed to unlock is left to the caller*: the vault works on its own
    copy.
  - *files over 128 MB are not loaded*: unlock, reload from disk and backup preview return
    TOO_LARGE without a `readFile` of that file.
- `src/main/vault/sidecars.security.test.ts` (F6): `readRegularFile` refuses directories, symlinks,
  FIFOs (without calling `readFile`) and files over the cap; a FIFO or oversized `.plk` reads as
  "held" at once and is neither removed nor released; a FIFO or oversized journal stops recovery
  at once and every file is kept; hashing a FIFO backup fails at once. The same with real FIFOs
  (`mkfifo`) on macOS and Linux (Windows has no FIFOs; the memory-backed tests run everywhere).
- `src/main/session.test.ts` (F12): the spell checker is turned off, its languages cleared and its
  download URL pointed at a missing local folder.
- `src/main/psafe3/secrets.test.ts`: the default random source's buffers for salt, K, L and IV are
  zero after `encode` (and the file still decodes); the stretch worker's main-thread password copy
  is zero once the worker has started, and P' is unchanged.

Each test was checked to fail with its fix reverted.

## Areas checked

### Main process IPC (`src/main/ipc`)
- **Sender check** (`register.ts`, `index.ts`): every invoke and the one-way `reportActivity` are
  refused unless the sender is our window's `webContents`, the frame is its main frame and the
  frame URL is our bundled `index.html` (or the dev-server origin, only when unpackaged).
  Covered by `lifecycle.test.ts` "registerIpc: only our own window may call". OK.
- **Argument validation** (`validate.ts`, `controller.ts`): argument count capped per channel,
  plain-object and exact-key checks, strings bounded (password 64 KB, fields 16 MB, ids 128 chars,
  paths 4096 chars, no NUL), enums checked, generator/settings ranges checked; failures become
  INVALID_ARGUMENT; any other exception becomes IO_ERROR with only the error class name logged.
  Covered by `controller.test.ts`. OK.
- **Locked state**: every vault channel checks the state before any dialog opens, and again after
  a dialog returns (Save As, export), so an auto-lock while a dialog is open is honoured. OK.
- **Paths from the renderer**: only `revealInFolder` takes one, and only for export files this run
  wrote. Recent files are opaque random ids mapped in main. OK.
- **Passwords over IPC**: lists and `getEntry` carry an empty password; copy happens in main
  (`clipboard.ts`); only `revealPassword` returns one. Covered by the WP7 IPC-spy tests (unit and
  E2E). OK.

### Preload (`src/preload/index.ts`)
One named function per channel with a fixed argument list, the object frozen, no generic
`invoke`/`send`/`ipcRenderer`, and event listeners receive the value only (never the
`IpcRendererEvent`, which would expose `sender`). Reviewed line by line; this is the basis for
accepting PRELOAD_JS_CHECK. OK.

### Window and session hardening (`window.ts`, `index.ts`)
`contextIsolation`, `sandbox`, no `nodeIntegration` (also in workers and sub-frames), `webSecurity`,
no insecure content, no experimental features, no `webviewTag`, `navigateOnDragDrop: false`,
DevTools only when unpackaged. App-wide: `will-navigate`, `will-redirect` and `will-attach-webview`
prevented, `setWindowOpenHandler` denies. Session: every permission request and check denied;
every request other than `file:`, `data:`, `blob:`, `devtools:` (and the dev server when
unpackaged) is cancelled; together with F12's fix the app makes no network requests. No `shell.openExternal`, no custom
protocols. E2E `wiring.spec.ts` proves `require`/`process`/`Buffer` are absent, `fetch`, remote
navigation and `window.open` fail. OK. See F1 and F9.

### CSP (`src/renderer/index.html`)
`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. No inline scripts
or styles, no `eval`, no `dangerouslySetInnerHTML`/`innerHTML` in the renderer (only the test
harness clears `document.body`). `data:` was dropped from `img-src` (F7): no image, CSS `url()` or
icon in the bundle uses it (checked in `src/renderer` and the built `out/renderer/assets`).
(`frame-ancestors` is ignored in a meta tag; harmless.)

### Test mode (`testMode.ts`)
`readTestMode` returns `undefined` when `app.isPackaged`, so the dialog stubs, the user-data
override and the IPC spy are unreachable in an installed app; `ELECTRON_RENDERER_URL` is likewise
ignored when packaged (`devServerUrl`). Covered by `lifecycle.test.ts` "is ignored in packaged
builds". With F1 fixed, `--inspect` is ignored too; F13 remains.

### File system and save pipeline (§A5, §A6)
- `db` is the real path resolved at open; open and every read check it is a regular file
  (`lstat`), so a FIFO or device chosen as the vault is refused.
- `.new`, staged backups and the journal are created with `O_CREAT|O_EXCL` (never follow or reuse
  an existing path), `.new` gets the database's exact mode bits (explicit `chmod` after the umask),
  the journal and `.plk` are `0600`, backups are copied with `COPYFILE_EXCL` (mode preserved).
  Temp names carry 6 random bytes. Cleanup only removes files this save created.
- Step 6 re-checks device, inode, size, mtime, hash and `realpath`; commit is `rename`, which does
  not follow a symlink planted at `db`; Save As to a new path commits with `link` so an appearing
  file is never clobbered. Save As refuses a destination with any existing `.plk`.
- Covered by WP6/WP8 fault-injection, symlink and real-disk suites. OK. See F6.

### Codec (§A4)
Checked in order: size bounds (232 B..128 MB), tag, iterations (2,048..2^24) before any stretching,
stretch in a worker with cancel, `timingSafeEqual` on H(P'), EOF exactly once on a block boundary
with exactly the HMAC after it, framing with field length ≤ 16 MB, ≤ 1,024 fields per record,
≤ 200,000 records, every length checked against the remaining bytes, then HMAC with
`timingSafeEqual` before anything is returned. Unexpected exceptions become CORRUPT_FILE with no
detail (so no file content leaks into messages). P', K||L and the decrypted body are zeroed in a
`finally`; field copies are zeroed if parsing fails part-way; Twofish `dispose()` zeroes the key
schedule. The WP8 malformed corpus proves no crash or hang. OK. See F2, F3.

### Export (§A7)
Written through `.<name>.<random>.tmp` created `O_EXCL` with mode `0600`, fsynced, then renamed
over the target (the umask can only remove bits, so the file is never wider than `0600`; a replaced
file gets the new mode). A target ending in `.psafe3`, or resolving to the open vault, is refused.
Nothing is deleted automatically. The plaintext warning is in the renderer (WP3). OK.

### Clipboard (§B5)
Copy happens in main; the value never reaches the renderer. Cleared after 30 s, on lock, on
close and on quit, only if the clipboard still holds our value; operations are serialised.
See F10.

### Logging
Every `log(...)` call in `src/main` was read: messages contain step numbers, error codes, errno
codes, sidecar base names and holder `user@host:pid` from a foreign `.plk`; never passwords or field
values. The renderer has no `console.*` calls. In tests, the only console output
is the pypwsafe skip notice, the benchmark timings and the generator's chi-square seed (random test
input, not a secret). CI oracle steps feed passphrases on stdin (`test/oracle/pwsafeCli.ts`). OK.

### Secret buffers (§A4.8)
The master password is converted to a `Buffer` in `controller.ts` and zeroed in a `finally`; the
vault keeps its own copy, zeroed on lock and close (a restore zeroes the one it replaces). On lock the model's field
buffers are zeroed (`wipeModel`), the backup preview is dropped, and with unsaved changes the model
is first re-encrypted in memory (§B3). Replaced field values on edit and deleted records are zeroed.
Strings (revealed passwords, typed text, IPC structured clones) can't be erased; the README says so.

## Findings in detail

**F1: Electron fuses (Medium, fixed).** `electron-builder.yml` had no `electronFuses` block, so an
installed app could be started with `ELECTRON_RUN_AS_NODE=1` (a signed Node binary), with
`NODE_OPTIONS`, or with `--inspect`, which attaches a debugger to the main process that later holds
the unlocked vault. Now set (electron-builder 26 flips them before signing, so the ad-hoc macOS
signature still verifies; the release workflow's `codesign --verify --deep --strict` checks it):

```yaml
electronFuses:
  runAsNode: false
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableCookieEncryption: true
  onlyLoadAppFromAsar: true
  enableEmbeddedAsarIntegrityValidation: true
```

The app does not use `child_process.fork` (key stretching uses `worker_threads`), so `runAsNode:
false` is safe. `grantFileProtocolExtraPrivileges` stays at Electron's default (on) until F9 moves
the page off `file://`. Playwright E2E runs the unpackaged Electron from `node_modules`, so it is
unaffected.

`build/smoke-packaged.mjs` now (a) reads the fuse wire of the packaged binary with `@electron/fuses`
and checks all six settings (not possible inside an AppImage, whose binary is compressed; the deb
check covers the same Linux build), (b) starts the app with `ELECTRON_RUN_AS_NODE=1 … -e <script>`
and requires the app window instead of the script's output, and (c) starts it with `--inspect=0`
and requires no "Debugger listening". Because Playwright's Electron launcher itself needs
`--inspect`, the smoke test now reaches the window through Chromium's DevTools protocol
(`--remote-debugging-port=0`, see F13) and quits with `Browser.close`. `NODE_OPTIONS` is checked
through the fuse wire only: Electron already ignores almost all `NODE_OPTIONS` (including
`--require`) in a packaged app, so a behavioural test would pass either way. Each check was seen to
fail on a local Linux build with the matching fuse flipped back.

**F6: sidecar reads (Low, fixed).** `readHolder` and `releaseLock` (`lockfile.ts`), the journal read
(`rotation.ts`), `hashOrNone` (`sidecars.ts`) and the backup preview/restore reads (`vault.ts`) now go
through `readRegularFile` (`src/main/fs/bounded.ts`): `lstat` first (symlinks not followed),
anything but a regular file is EINVAL, and sizes are capped: `.plk` 16 KB, journal 64 KB, backups
1 GB (our own backups are at most 128 MB; Save As over an existing file keeps that file as its
`.bak` whatever its size, so this cap only stops absurd sizes), backup preview 128 MB. A refused
`.plk` counts as "held by someone" (never removed automatically); a refused journal stops recovery
with the "recovery failed" banner and every file is kept.

**F12: spell-checker dictionary download (Medium, fixed).** `webPreferences.spellcheck: false` only
stops checking inside the page. The session still loads a hunspell dictionary for the UI language
and, on Linux and Windows, downloads it from Google's CDN (`redirector.gvt1.com/edgedl/chrome/dict/
en-us-10-1.bdic`) through the browser process, which our `webRequest` filter never sees. Fix:
`disableSpellChecker` (`src/main/session.ts`) turns the spell checker off, clears its languages and
points the download URL at a missing `file://` folder, for every session (`session-created`) and
again for the default session. Checked with Chromium's net log (`--log-net-log`) while typing in the
unlock field: 12 requests to `gvt1.com` before, none after. macOS uses the OS spell checker and never
downloaded.

**F13: `--remote-debugging-port` (Low, open).** No Electron fuse disables this Chromium switch. The
main process could refuse to start when `app.commandLine.hasSwitch('remote-debugging-port')` in a
packaged build, but the packaged smoke test relies on it (see F1); left for the lead to decide.
Anyone able to launch the app with extra arguments as the user can also read that user's files and
keystrokes, so this is outside the threat model.

**F9: `file://` origin (Low).** A custom `app://` protocol (`protocol.handle`) would give the page a
unique origin so `'self'` no longer matches arbitrary local files. There is no HTML-injection path
today and no network to exfiltrate to, so this is a v1.1 hardening item.

**F10: clipboard (Low).** On macOS, also write the `org.nspasteboard.ConcealedType` and
`org.nspasteboard.TransientType` markers (`clipboard.writeBuffer`) so well-behaved clipboard
managers skip the value; on Windows, the `ExcludeClipboardContentFromMonitorProcessing` format.
Needs testing on each OS, so left for v1.1.

## Electronegativity

Command (not added to `package.json`), run on the sources and on the built app after `npm run build`:

```sh
npx -y @doyensec/electronegativity@1.10.3 -e 44.4.5 -i src -o eneg-src.csv
npx -y @doyensec/electronegativity@1.10.3 -e 44.4.5 -i out -o eneg-out.csv
```

`-e 44.4.5` gives the Electron version; without it the tool assumes v0.1.0 and adds a spurious
REMOTE_MODULE_JS_CHECK (the remote module was removed in Electron 14).

| Check | Severity | Where | Outcome |
|---|---|---|---|
| PRELOAD_JS_CHECK | MEDIUM (FIRM) | `src/main/window.ts:26` / `out/main/index.js` | Accepted by the lead after review. It is a generic "review your preload" prompt raised for any preload; the preload was reviewed (see Preload above): sandboxed, context-isolated, one fixed function per channel, frozen, no Electron objects exposed. |
| CSP_GLOBAL_CHECK | LOW (FIRM) | `src/renderer/index.html:5` / `out/renderer/index.html` | Accepted (F8). The flagged directive is `script-src 'self'` (csp-evaluator: "'self' can be problematic if you host JSONP, Angular or user uploaded files"); it is not `img-src data:`, which the tool does not flag. Removing it would need hashes/nonces for the Vite bundle; we host none of those things, there is no inline script, and `connect-src 'none'` plus the session filter block exfiltration. |

Result: **zero HIGH, one MEDIUM (accepted), one LOW (accepted)**, the same on `src` and `out`.

## Dependency audit

Run on the committed lockfile (npm 10.9.7, Node 22.22.2):

| Command | Result |
|---|---|
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `npm audit` | found 0 vulnerabilities |
| `npx -y license-checker@25.0.1 --production --summary` | MIT: 3 (`react`, `react-dom`, `scheduler`); UNLICENSED: 1 (this package, which is `private` and has no `license` field) |
| `npx -y license-checker@25.0.1 --summary` (all, dev included) | MIT 376, ISC 40, Apache-2.0 26, BSD-2-Clause 14, BSD-3-Clause 12, BlueOak-1.0.0 9, MIT-0 2, 0BSD 1, CC0-1.0 1, (MIT OR CC0-1.0) 1, Python-2.0 1, MPL-2.0 1, CC-BY-4.0 1, WTFPL 1, (WTFPL OR ISC) 1, (WTFPL OR MIT) 1 |

- **No copyleft in what ships.** The packaged app contains only our bundle (React is bundled into
  the renderer; `node_modules` is excluded by `electron-builder.yml`) plus Electron (MIT) and the
  Chromium/Node notices Electron ships. The vendored Twofish keeps its notice
  (`src/main/crypto/twofish/LICENSE-NOTICE.md`).
- **Dev only, weak copyleft or unusual:** `axe-core` (MPL-2.0, file-level copyleft, used only in
  component tests, not shipped or modified); `argparse` (Python-2.0), `caniuse-lite` (CC-BY-4.0) and
  the WTFPL packages (`sanitize-filename` via electron-builder and its helpers) are permissive. No
  GPL, LGPL or AGPL anywhere in the tree.
- **Open question for the lead:** the repository has no `LICENSE` file and `package.json` has no
  `license` field. Pick one before v1.0 (pypwsafe is reference-only, so GPL does not apply).
- **Versions:** `electron` 44.4.5 is the current `latest` (checked with `npm view electron
  dist-tags`). `npm outdated` lists only dev tooling majors (`@types/node` 26, `@vitejs/plugin-react`
  6, `jsdom` 30, `typescript` 7, `vite` 8); none has an advisory, so **no upgrade is proposed** for
  v1.0. Keep Electron on the latest 44.x patch at release time.

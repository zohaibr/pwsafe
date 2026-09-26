# Vault service (WP6)

Main-process service behind the `PsafeApi` (`src/shared/ipc.ts`). One database is open at a
time. It owns the master password, the decrypted records, the `.plk` lock (§A6), dirty tracking,
save / Save As / backups / restore and open-time recovery (§A5), and the in-memory re-encryption
on lock (§B3). No Electron imports here, in `src/main/lockfile` or in `src/main/fs`; WP7 injects
everything and does the dialogs, clipboard, recent files and IPC.

Every method returns a `Result` (`src/shared/errors.ts`) and never throws. Methods that change the
vault are queued and run one at a time in call order.

## Construction

```ts
import { hostname, userInfo } from 'node:os'
import { createTwofish } from '../crypto/twofish/twofish'
import { createNodeFileSystem } from '../fs'
import { Vault } from '../vault'

const vault = new Vault({
  fs: createNodeFileSystem(),
  platform:
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
  identity: { user: userInfo().username, host: hostname(), pid: process.pid },
  processExists: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH'
        ? false
        : (e as NodeJS.ErrnoException).code === 'EPERM'
          ? true
          : undefined
    }
  },
  codec: { cipherFactory: createTwofish }, // stretch defaults to the worker thread
  appName: `psafe3 Opener V${app.getVersion()}`, // header "last saved by" application
  log: (m) => console.warn(m), // optional; messages never contain secrets
})
```

Optional: `now` (epoch ms), `sleep`, `onSaveStep` (diagnostics/tests).

## API → `PsafeApi` mapping

| PsafeApi                                        | Vault                              | Notes                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chooseFile`, `chooseRecentFile`                | `open(path)`                       | WP7 shows the dialog first; `open` closes any open file (ask first when dirty). Resolves symlinks, reads nothing, takes no lock. Returns `{ fileName }`.                                                                                                                                                                    |
| `unlock(password, { lockChoice })`              | `unlock(bytes, { lockChoice })`    | Pass the password as bytes (`Buffer.from(str, 'utf8')`) and zero your copy afterwards; the vault keeps its own. First unlock returns `LOCKED_BY_OTHER` with `detail` `user@host:pid` when another app holds the `.plk`; call again with `lockChoice` after the dialog (`'remove-lock'` only after the second confirmation). |
| `cancelUnlock`                                  | `cancelUnlock()`                   | Synchronous; the pending `unlock` resolves `CANCELLED`.                                                                                                                                                                                                                                                                     |
| `lock(options)`                                 | `lock({ discardChanges })`         | Without `discardChanges`, unsaved changes are re-encrypted in memory and come back after unlock (use this for idle/sleep/screen-lock/minimise auto-lock). The `.plk` stays held while locked.                                                                                                                               |
| `getState`, `onStateChanged`                    | `getState()`, `onStateChanged(fn)` | `onStateChanged` returns an unsubscribe function. Banners and `readOnly` are only present while `status === 'open'`.                                                                                                                                                                                                        |
| `closeFile` (and quit)                          | `close()`                          | Drops unsaved changes (ask first), releases the `.plk`. Call on quit too.                                                                                                                                                                                                                                                   |
| `listEntries`, `listGroups`, `getEntry`         | same names                         | Passwords are always `''`.                                                                                                                                                                                                                                                                                                  |
| `revealPassword`                                | `revealPassword(uuid)`             | Aliases/shortcuts resolve to the base's password.                                                                                                                                                                                                                                                                           |
| `copyField`                                     | `getFieldForCopy(uuid, field)`     | Returns the value; WP7 writes the clipboard in main and runs the 30 s timer.                                                                                                                                                                                                                                                |
| `saveEntry`, `deleteEntry`                      | same names                         | `RECORD_READ_ONLY` for read-only records and for bases with dependants (`detail` "Other entries depend on this one.").                                                                                                                                                                                                      |
| `reloadFromDisk`                                | `reloadFromDisk()`                 | Conflict dialog "Reload (discard my changes)".                                                                                                                                                                                                                                                                              |
| `save`                                          | `save()`                           | See outcomes below.                                                                                                                                                                                                                                                                                                         |
| `saveAs`                                        | `saveAs(destinationPath)`          | WP7 shows the native save dialog (it asks about replacing) and maps a cancelled dialog to `ok(null)` itself.                                                                                                                                                                                                                |
| `listBackups`, `previewBackup`, `restoreBackup` | same names                         | `previewBackup(id, passwordBytes)`; `restoreBackup(id)` needs a preview of that id first. Restore drops unsaved changes (ask first); the vault then uses the backup's password.                                                                                                                                             |
| `exportXml`                                     | `getExportData()`                  | Returns `{ header, records, databaseName }` for `buildXmlExport` (`src/main/export`). It includes unsaved edits; use it before the next lock (which zeroes the buffers).                                                                                                                                                    |

## Outcomes (§A5 table)

| Result                                      | Meaning                                                                                                                              | State          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `ok(state)`                                 | Saved. `state.banners` may contain `id: 'rotation'` ("Saved. Backup rotation didn't finish; …") or `id: 'backup-unknown'`.           | `dirtyCount` 0 |
| `FILE_CHANGED_ON_DISK`                      | Step 1 or 6: file changed, replaced, or the opened symlink now points elsewhere. Nothing written. Offer Save As / Reload / Cancel.   | unchanged      |
| `SAVE_FAILED`, `detail` `"Step N: reason."` | Steps 1–7 failed. Database and every backup unchanged; staged files removed.                                                         | still dirty    |
| `SAVED_DURABILITY_UNCONFIRMED`              | Saved, but the directory fsync failed. Not a failed save.                                                                            | `dirtyCount` 0 |
| `READ_ONLY`                                 | Opened read-only (`state.readOnly.reason`: `windows-v1`, `newer-format`, `locked-by-other`, `lock-not-created`). No write path runs. |                |
| `LOCKED_BY_OTHER` (Save As)                 | The destination has a `.plk` (another app, or this app's own lock name). Nothing written.                                            |                |

Open-time banners: `network` (warning), `recovery` (info, recovery tidied up or finished a
rotation), `backup-unknown` (warning, lists the files; nothing was moved), `recovery-failed`.

## Files next to the database

`foo.psafe3.bak`, `.bak2`, `.bak3` (backups, newest first); during a save only:
`.foo.psafe3.<tag>.new`, `.foo.psafe3.<tag>.bak-staged`, `.foo.psafe3.rotation.json`; the lock
`foo.plk` (Password Safe's name rule: the last `.` of the path is replaced).

## Known limits (for the README security section)

- The `.plk` is cooperative, and a short gap remains between the step-6 check and the step-7
  rename; `rename` replaces the directory entry and does not follow a symlink placed at `db`.
- Node's `fsync` on macOS does not issue `F_FULLFSYNC`.
- On volumes without hard links, Save As to a new path falls back to "check, then rename".
- Network-volume detection: Linux `statfs` magic numbers; macOS parses `/sbin/mount` output.

# Release checklist (gate for v1.0)

This is the §E checklist from `docs/execution-plan.md`. Tick an item only when every line under
it is true for the release commit.

- **Automated** items name the test that proves them. Tick them when CI is green on macOS, Windows
  and Linux for the release commit, including the `Compatibility oracle` job.
- **Manual** items are for Zo on a Mac, with exact steps. Write what you record into the release
  notes.

Test files: use **copies** of the committed fixtures in `test/fixtures/generated/`. The password
for each one is the `password` value in its `.expected.json`, for example `cli-add.psafe3` uses
`wp8-fixture-add`. Never use a real password database for these checks. The one exception is the
final acceptance test, which uses a copy of your real file.

Release commit: `__________` · CI run: `__________` · Date: `__________`

---

## 1. Oracle round trip in both directions

- [ ] **Automated.** Every fixture passes the §A2 oracle comparison in both directions against
      `pwsafe-cli 1.25.0`. The SHA `da4460325ac41ccd798a52d9b250ef4d5c768abc` is recorded in
      `docs/references.md`, and the CI oracle job checks it when it builds the CLI.
  - `test/oracle/cli-to-ours.test.ts`: "every value we decode equals the CLI export of the same
    file", plus the multi-line notes, cli-links and regenerate tests
  - `test/oracle/ours-to-cli.test.ts`: "after edits, adds and deletes, pwsafe-cli exports exactly
    the expected values, and untouched data survives"
  - `test/oracle/xml-reimport.test.ts` and `test/oracle/vault-backups-cli.test.ts`
  - `test/integration/fixtures.test.ts`: "no-edit round trip keeps every field byte-for-byte
    except the save metadata"

## 2. Files that are not V3 are refused and left untouched

- [ ] **Automated.** A V4 file and a random non-psafe file are refused with `UNSUPPORTED_FORMAT`.
      Afterwards their bytes and modification times are unchanged, and no `.plk` is created.
  - `test/e2e/open-errors.spec.ts`: "a V4 file is refused with UNSUPPORTED_FORMAT; bytes, mtime and
    folder unchanged"
  - `test/e2e/open-errors.spec.ts`: "a random non-psafe file is refused with UNSUPPORTED_FORMAT;
    untouched"

## 3. Bad files each get their own message and are left untouched

- [ ] **Automated.** A wrong password, a corrupted file, a truncated file and a file with too many
      key-stretching rounds each show their own message. The file's bytes and mtime are unchanged,
      and nothing is left next to it.
  - `test/e2e/open-errors.spec.ts`: "wrong password shows WRONG_PASSWORD…", "corrupted file
    (damaged HMAC) shows INTEGRITY_FAILED…", "truncated file shows CORRUPT_FILE…" and "over-cap key
    stretching is refused with UNSUPPORTED_FORMAT before stretching". The `afterAll` check fails if
    any two of these share a message.
  - Full malformed corpus: `test/integration/malformed.test.ts`

## 4. Saving is safe: fault injection, kill test, backups, Save As, restore

- [ ] **Automated.** The fault-injection suite is green.
  - `src/main/vault/vault.faults.test.ts`: "fault injection with …", covering "injected failure at
    op …", "process death at op …" and "torn write then death at op …"
  - `test/integration/vault-recovery.test.ts`: "§A5 crash recovery on a real disk"
- [ ] **Automated.** 3 backup generations rotate.
  - `test/e2e/backups.spec.ts`: "three backup generations rotate over four saves"
- [ ] **Automated.** Save As and Restore from backup work in the real app.
  - `test/e2e/full-flow.spec.ts`: "unlock → search → copy → add → edit → delete → save → reopen →
    export → Save As → restore"
  - `src/main/vault/vault.saveas.test.ts` ("§A5 Save As") and `test/integration/vault-saves.test.ts`
- [ ] **Manual: kill during save (macOS).** Afterwards the database is valid and the backups are
      intact.
  1. Copy `test/fixtures/generated/cli-many.psafe3` to `~/kill-test/vault.psafe3`.
  2. Open it in the installed app (password `wp8-fixture-many`). Edit any entry, then **Save**.
     Repeat this three times so that `.bak`, `.bak2` and `.bak3` exist. Check with
     `ls -la ~/kill-test`.
  3. Edit one entry, but don't save yet. In Terminal, run:
     `sleep 2; pkill -9 -f "psafe3 Opener.app/Contents/MacOS"`
     Switch back to the app and press **⌘S** within those 2 seconds.
  4. Do step 3 **five times**. Vary how long you wait before pressing ⌘S, so the kill lands at
     different points of the save.
  5. After each kill:
     - Reopen the app and the file. It opens with the password.
     - An info banner may say that recovery ran. That is fine.
     - `ls -la ~/kill-test` shows no `.new`, `.bak-staged` or `.rotation.json` files once the file
       is open.
     - File → **Restore from backup…** lists the backups, and each one opens in **Preview** with
       the password.
  6. Open the final `vault.psafe3` in Password Safe 1.25.0 for macOS. It opens without errors.

## 5. `.plk` interop with Password Safe for macOS (§A6 cases a–c)

- [ ] **Manual.** Install Password Safe **1.25.0** for macOS. Record the exact version from its
      About box: `__________`. Use a copy of `cli-add.psafe3` (`wp8-fixture-add`) at
      `~/plk-test/vault.psafe3`.
  - [ ] **(a) Password Safe first.** Open the file in Password Safe for editing (not read-only).
        Then open it in our app and unlock. Expected: our app shows "File is in use", naming the
        user and host, and offers **Open read-only**. Choose it: the vault opens with the read-only
        banner.
  - [ ] **(b) Our app first.** Quit both apps. Open and unlock the file in our app, then open it
        in Password Safe. Expected: Password Safe reports that the file is locked or in use.
  - [ ] **(c) Normal quit releases the lock.** In our app press **⌘Q**. Then
        `ls ~/plk-test` shows no `vault.plk`. Open the file in Password Safe: no lock prompt.

## 6. XML export

- [ ] **Automated.** The plaintext warning is shown, the "I understand" checkbox is required, and
      the file is written with mode `0600`.
  - `test/e2e/full-flow.spec.ts` (the export step)
  - Schema: `test/oracle/xml-reimport.test.ts` "validates against pwsafe.xsd and imports into a new
    safe"
- [ ] **Manual: KeePass 2.x import.**
  1. In our app, open `cli-add.psafe3` and use File → **Export XML…** → All entries.
  2. On Windows, or on macOS with KeePass 2.x under Mono, install the latest **KeePass 2.x**.
     Record the version: `__________`.
  3. Create a new database, then File → **Import…** → **Password Safe XML** → pick the export.
  4. Record the entry count (expect 13): `____`.
  5. Spot-check "Example Bank" (username, password, URL, notes with `<xml> & "quotes"`), the
     Unicode entry "Unicode ü 日本語 🔑" and the group `a.b.c`.
- [ ] **Manual: Bitwarden import.**
  1. In the Bitwarden web vault, go to Tools → **Import data** → format **Password Safe (xml)** and
     choose the same export.
  2. Record the Bitwarden web vault version (Settings → About): `__________`.
  3. Record the item count (expect 13): `____`. Spot-check the same three entries.
  4. Delete the imported items and the exported XML afterwards.

## 7. Auto-lock keeps unsaved changes and writes nothing

- [ ] **Automated.** Auto-lock by idle, sleep, screen lock and minimise (when the setting is on)
      with unsaved changes writes nothing to disk. The changes are back after unlock and still
      unsaved. The clipboard is cleared only if it still holds our value.
  - `test/e2e/autolock.spec.ts`: "idle auto-lock with unsaved changes writes nothing and keeps the
    changes". It uses the real Settings dialog with the 1-minute minimum; main's timer is scaled so
    the minute passes in 1.5 s.
  - `test/e2e/autolock.spec.ts`: "screen lock and sleep auto-lock keep the changes and leave a
    foreign clipboard alone". It emits the `powerMonitor` events that the OS would send.
  - `test/e2e/autolock.spec.ts`: "minimise locks only when the setting is on, and keeps the
    changes"
  - `src/main/ipc/controller.test.ts`: "clipboard in main (§A4.8, §B5)"
- [ ] **Manual spot check (macOS).** The real OS events are only simulated in CI, so check them
      here. Open a copy of `cli-add.psafe3`, make one edit, don't save, and copy a password.
  - Press **⌃⌘Q** to lock the screen, then log back in. The app is locked.
  - Unlock the file. "Unsaved changes (1)" shows, and the file's modified time in Finder did not
    change.
  - Do the same with  → **Sleep**, and with minimise after turning on "Lock when the window is
    minimised" in Settings.

## 8. Data-flow tests (§A4.8) and the README

- [ ] **Automated.** No password crosses to the renderer except in a reveal, the renderer holds no
      entry data after lock, and owned key buffers are zero after lock.
  - `test/e2e/wiring.spec.ts`: "opens, edits, saves and exports a copy of a fixture; no password
    crosses IPC except reveal"
  - `src/main/ipc/controller.test.ts`: "§A4.8 IPC spy: passwords cross only in a revealPassword
    response"
  - `src/main/vault/vault.test.ts`: "§B3 lock with unsaved changes" (owned buffers zeroed)
- [ ] **Manual.** The "Security notes" section of `README.md` states the memory limits: clearing
      secrets is best effort, and strings can stay in memory.

## 9. Hardening and no network

- [ ] **Automated.** The renderer has no Node, no remote navigation and no new windows.
  - `test/e2e/wiring.spec.ts`: "renderer has no Node, no remote navigation, no new windows, no
    network"
- [ ] **Automated. Not passing yet.** No network requests during a full end-to-end run.
  - `test/e2e/network.spec.ts`: "the full journey makes no network requests". It records with
    Chromium's net log from process start, a session `webRequest` recorder and Node's
    diagnostics channels. "all three network recorders are live during the full journey" proves
    each recorder catches a deliberate request.
  - **Known blocker:** on Linux, Chromium's spellchecker downloads
    `https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic` once a text field is edited.
    The app's session filter never sees this request. The test is marked `test.fail` on Linux
    until main turns the spellchecker, or its dictionary download, off. Tick this item only after
    that fix, with the `test.fail` line removed and the test green on all three OSes.
- [ ] **Manual (or from the security review PR).** The Electronegativity scan shows no high or
      medium findings. Run it in a scratch clone, not as a project dependency:
      `npx @doyensec/electronegativity -i . -o /tmp/electronegativity.csv`
      Record the tool version and the result: `__________`.

## 10. Clean-machine install of the unsigned `.dmg`

- [ ] **Manual, on both Apple Silicon and Intel.** Use a Mac, or a fresh macOS user account or
      VM, that has never run the app. Target the current and the previous major macOS.
  1. Create a fresh user: System Settings → Users & Groups → **Add User…**. Log in as that user.
  2. From the GitHub **Releases** page, download the `.dmg` for the architecture: arm64 for Apple
     Silicon, x64 for Intel.
  3. Open the `.dmg` and drag **psafe3 Opener** to Applications. Open it from Applications. macOS
     blocks it.
  4. Go to System Settings → **Privacy & Security**, scroll to the message about psafe3 Opener,
     and click **Open Anyway**. Authenticate, then click **Open**.
  5. The app starts. Open a copy of `cli-add.psafe3` and unlock it: 13 entries.
  6. Quit the app and open it again. It starts with no warning.
  7. Record for each machine: macOS version `______`, architecture `______`, hardware
     `______`.
  - [ ] Apple Silicon: current macOS
  - [ ] Apple Silicon: previous major macOS
  - [ ] Intel: current or previous major macOS

## 11. Unlock benchmark on Apple Silicon

- [ ] **Automated.** Unlock at 262,144 rounds takes 1 s or less on the macOS Apple Silicon CI
      runner.
  - `src/main/psafe3/stretch.bench.test.ts`, run by the "Key-stretching benchmark" CI step. See
    `docs/benchmarks.md`: 0.25 s for the shipped worker. Check the number in the release commit's
    macOS job log: `______ s`.
- [ ] **Manual (Apple Silicon Mac).** In a clone of the repo, run
      `PSAFE3_BENCH=1 npx vitest run src/main/psafe3/stretch.bench.test.ts --silent=false`.
      Record the worker time at 262,144 rounds: `______ s`, which must be 1 s or less.
      Then, in the installed app, unlock a copy of `cli-add.psafe3`. It uses 327,680 rounds, more
      than the budget's 262,144. Clicking **Unlock** should open the list in well under 1.5 s.

## 12. Windows is read-only

- [ ] **Automated.** The Windows build opens vaults read-only, and no write path is reachable.
  - `test/e2e/windows.spec.ts`: "Windows opens the vault read-only and refuses every write path".
    Save, edit, add, delete, Save As and restore are each refused with `READ_ONLY`. No `.plk` is
    created, and the file and its backup are unchanged. This runs only on the Windows CI job.
  - `src/main/vault/vault.lock.test.ts`: "win32: v1 opens every vault read-only; no write path is
    reachable"

## 13. Backup-rotation recovery is idempotent

- [ ] **Automated.** The fault-injection suite with repeated recovery is green.
  - `src/main/vault/vault.faults.test.ts`: each fault case runs recovery twice and after a killed
    recovery
  - `test/integration/vault-recovery.test.ts`: "§A5 crash recovery on a real disk"

## 14. Known app bugs shown by e2e tests (must be fixed before v1.0)

- [x] `test/e2e/app-bugs.spec.ts`: "clicking an entry in a scrolled list selects that entry".
      When nothing visible was selected (after Restore, or when search hid the selected entry),
      clicking an entry in a scrolled list selected the first entry instead. Fixed in
      `src/renderer/src/screens/EntryList.tsx` (focus from a pointer no longer auto-selects).
- [ ] The spellchecker download in item 9.

## 15. Accessibility (§B7)

- [ ] **Manual: VoiceOver pass on macOS.** Turn VoiceOver on with **⌘F5**. Using only the keyboard,
      with a copy of `cli-add.psafe3`:
  - The start screen, unlock field and Unlock button are announced with their names.
  - Tab order is toolbar → groups → list → details. Every icon-only button is announced by name,
    for example "Copy password", "Show password" and "Show groups".
  - **⌘F** focuses search, **⌘N** opens a new entry, **⌘S** saves and **⌘L** locks. **Delete**
    on a selected entry opens the delete dialog, and focus starts on Cancel.
  - The dialogs (delete, unsaved changes, export, restore and settings) announce their titles, and
    Escape closes them.
  - The read-only banner and the error messages (try a wrong password) are announced.

---

## Acceptance test (Zo)

- [ ] Install the `.dmg` on your Mac. Open a **copy** of your real file, make a change and save.
      Then confirm that Password Safe still opens it with everything intact.

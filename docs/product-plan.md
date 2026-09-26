# Plan: Local psafe3 Opener (Electron)

**Goal:** A desktop app that opens a Password Safe v3 (`.psafe3`) file with its master password and lets you add, edit and delete entries, then saves a file that Password Safe itself still opens.

## Scope (v1)
- Open an existing `.psafe3` file and unlock it with the master password.
- Show entries in a searchable list, grouped by Group (tree on the left, list in the middle, details on the right).
- Add, edit and delete entries: Title, Group, Username, Password, URL, Email, Notes.
- Copy username or password to the clipboard, cleared automatically after 30 seconds.
- Built-in password generator (length and character sets).
- **Export to XML** in Password Safe's own XML format, which KeePass, Bitwarden and others can import. The file is unencrypted, so the app warns before writing it and suggests deleting it after import.
- Save back to the same file. Nothing leaves your machine: no network, no sync, no telemetry.
- **Out of v1:** creating new databases, changing the master password, password history, attachments, YubiKey, import, CSV export. Easy to add later.

## How the psafe3 format works (what we must implement)
1. **Header:** `PWS3` tag, 32 byte salt, iteration count, and `H(P')`, a SHA-256 hash used to check the password.
2. **Key stretching:** SHA-256 of password + salt, then re-hashed *iter* times. Wrong password is detected by comparing against `H(P')`.
3. **Keys:** blocks B1–B4 hold the real record key K and HMAC key L, encrypted with **Twofish-ECB** under the stretched key.
4. **Body:** a 16 byte IV, then all header fields and records encrypted with **Twofish-CBC** using K. Each field is length (4 bytes) + type (1 byte) + data, padded to 16 bytes. Field type `0xFF` ends a record.
5. **Footer:** `PWS3-EOFPWS3-EOF` marker, then an **HMAC-SHA256** (key L) over all field data, which we verify on open and recompute on save.

Node's built-in crypto covers SHA-256 and HMAC but **not Twofish**, so we use a small, well-known pure JS Twofish implementation (or port one) and prove it with the official Twofish test vectors before trusting it.

## What we take from pypwsafe (your reference project)
- **Same core flow:** add, update, delete and dump records by UUID, like its `pwsafecli`; the same stretch-key, B1–B4, HMAC steps; unknown fields kept verbatim.
- **Its 9 test safes** (password `bogus12345`) become our test fixtures for open, round-trip and HMAC checks.
- **`.plk` lock file** next to the database (`user@host:pid`), so we and Password Safe don't edit the same file at once.
- **Do better where it falls short:** it's Python 2 only, needs native mcrypt (broken on Windows) and overwrites the file in place. We use pure JS Twofish (works everywhere) and safe saves.
- **License note:** pypwsafe is GPLv2, so we reimplement from the published format spec and use it only as a reference, which keeps your license choice open.

## Architecture
- **Electron + TypeScript + Vite**, React for the UI.
- **Main process** owns the file and all crypto (`psafe3` module: parse, decrypt, encrypt, serialize). The renderer never sees keys.
- **Renderer** is sandboxed: `contextIsolation` on, `nodeIntegration` off, strict CSP, and it talks to main only through a narrow preload API (`open`, `unlock`, `listEntries`, `saveEntry`, `deleteEntry`, `save`, `lock`).
- Passwords are sent to the UI only when revealed or copied.

## Keeping your data safe
- **Round-trip fidelity:** any header fields or record fields we don't understand are kept byte for byte and written back unchanged, so Password Safe loses nothing.
- **Safe saves:** write to a temp file, verify it re-opens and the HMAC checks out, keep a `.bak` of the previous file, then atomically rename into place.
- **Auto-lock** after idle time (default 5 minutes) and on window minimize, wiping decrypted data from memory as far as JavaScript allows.
- New salt and IV generated on every save; iteration count kept at or above the file's existing value and raised to at least 262,144 (Password Safe 3.68+ minimum).
- Detailed format scope, round-trip contract, save/backup/restore and lock rules: see `psafe3-execution-plan.md` v2, section A.

## Milestones
1. **psafe3 library + tests:** Twofish test vectors, open all pypwsafe test safes, round-trip them with no changes, and confirm Password Safe opens our output.
2. **Read-only app:** open, unlock, browse, search, copy to clipboard, auto-lock.
3. **Editing:** add, edit, delete, password generator, safe save with backup, XML export.
4. **Packaging:** a macOS `.dmg` (Apple Silicon + Intel) via electron-builder, plus Windows and Linux builds from CI.

## What I need from you
- **A GitHub repository** for the new app (new or existing), connected to this project.
- Optional: a throwaway `.psafe3` from your current Password Safe version, to test against newer fields. Please don't share a real one.

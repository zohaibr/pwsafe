# psafe3 Opener

A desktop app for opening and editing [Password Safe](https://pwsafe.org) V3 (`.psafe3`) files,
fully offline. Built with Electron, TypeScript and React.

> Status: early development. See `docs/execution-plan.md` for the plan and what each work package delivers.

## Development

Requires Node 22.

```sh
npm install          # also downloads the Electron binary
npm run dev          # run the app with live reload
npm test             # unit tests
npm run lint         # ESLint + Prettier
npm run typecheck
npm run test:e2e     # build, then launch the app with Playwright (Linux: prefix with xvfb-run -a)
npm run fixtures:pypwsafe   # download pypwsafe's test safes (pinned and checksummed)
```

### Compatibility oracle (Linux)

Tests in `test/oracle/` compare our files with the official `pwsafe-cli` from Password Safe 1.25.0.
They are skipped unless the CLI is available:

```sh
sudo apt-get install -qy $(cat scripts/oracle/apt-deps.txt)
scripts/oracle/build-pwsafe-cli.sh
PWSAFE_CLI=.oracle/pwsafe-cli PWS_XMLDIR=$PWD/.oracle/xml/ npx vitest run test/oracle
```

## Security notes

- **No network.** The app makes no network requests and has no telemetry or update checks; any
  request from the window is blocked.
- **Where secrets live.** The file, the master password and all keys stay in the main process. The
  window is sandboxed and isolated (no Node, no navigation, no new windows, strict Content Security
  Policy, all permission requests denied, DevTools off in installed builds) and talks to the main
  process through a small fixed set of calls that are checked on arrival. It only receives a
  password when you click Show; copying happens in the main process, and the clipboard is cleared
  after 30 seconds, on lock and on quit if it still holds what we copied.
- **What we clear, and what we can't promise.** On lock and close we overwrite the master
  password, the keys and the decrypted data we hold in buffers. JavaScript strings can't be
  erased, so a password you revealed, text you typed into a field, and values passed between the
  window and the main process may stay in memory until overwritten. Clearing memory is best
  effort, not a guarantee.
- **Exports are not encrypted.** XML exports are written readable only by you (`0600`); delete them
  when done.
- **Lock files are cooperative.** The `.plk` lock only stops apps that honour it, such as Password
  Safe itself. A save checks that the file hasn't changed just before replacing it; a very short
  gap remains after that check, and the replace never follows a symlink put in the file's place.

See `docs/security-review.md` for the full review and dependency audit.

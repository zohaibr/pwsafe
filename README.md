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

- The file, the master password and all keys stay in the main process. The renderer is sandboxed
  and only receives a password when you explicitly reveal it.
- Clearing secrets from memory is best effort. JavaScript strings (for example a revealed password
  or text typed into a field) can't be reliably erased and may stay in memory until overwritten.
- The `.plk` lock file only stops apps that honour it, such as Password Safe itself.

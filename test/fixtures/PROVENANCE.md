# Test fixture provenance

Every file under `test/fixtures/` is listed here with how it was made. Real password databases and
real passwords are never committed.

## Committed fixtures (`test/fixtures/generated/`)

Files we create ourselves, with our own made-up content, using the pinned `pwsafe-cli` oracle
(Password Safe 1.25.0, see `docs/references.md`) or by hand in the Password Safe app. Each has an
`*.expected.json` next to it, written independently of our parser.

| File | Made with | Contents | Password |
| ---- | --------- | -------- | -------- |
| _(none yet; WP2 and WP8 add them)_ | | | |

## Downloaded at test time (not committed)

`npm run fixtures:pypwsafe` downloads the 8 test safes from
[pypwsafe](https://github.com/ronys/pypwsafe) at commit `05ae8a2f7de07e1606d062a0135c43ffc0b0e22c`
into `test/fixtures/pypwsafe/` (git-ignored) and checks each file's SHA-256
(`scripts/fetch-pypwsafe-fixtures.mjs`). pypwsafe is GPLv2 and its authors are Paulson McIntyre,
Evan Deaubl, Sean Perry, Rony Shapiro and contributors. We only use these files as test input.
All 8 open in `pwsafe-cli` 1.25.0 with the password `bogus12345`.

| File | Entries | Format |
| ---- | ------- | ------ |
| EmptyGroupTest.psafe3 | 9 | 0x030B |
| LastSaveUserTest.psafe3 | 9 | 0x030B |
| NonDefaultPrefsTest.psafe3 | 9 | 0x030B |
| RecentEntriesTest.psafe3 | 9 | 0x030B |
| VersionTest.psafe3 | 9 | 0x030B |
| passwordPolicyTest.psafe3 | 4 | 0x030B |
| simple.psafe3 | 9 | 0x0309 |
| unknown-record-prop-1.psafe3 | 1 | 0x0309 |

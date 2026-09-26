# Pinned references

Everything the specs and the compatibility tests depend on, pinned to exact revisions.
Changing any pin needs lead review.

## Format specifications
- Password Safe V3 format, spec version 3.31: `docs/formatV3.txt` in pwsafe/pwsafe
  (read at commit `da4460325ac41ccd798a52d9b250ef4d5c768abc`, tag 1.25.0).
- Password Safe V4 format: `docs/formatV4.txt`, same commit. Used only to define what we reject.

## Password Safe source (lock behaviour, CLI oracle, XML schema)
| Tag | Commit | Used for |
| --- | ------ | -------- |
| `1.25.0` (macOS/Linux line) | `da4460325ac41ccd798a52d9b250ef4d5c768abc` | `src/os/mac/file.cpp` and `src/os/unix/file.cpp` (lock files), `src/ui/cli/` (oracle), `xml/pwsafe.xsd` |
| `3.72.2` (Windows line) | `4996b377424e286c9c71c082b6ccd81a0719084e` | `src/os/windows/file.cpp` (lock files) |

## pwsafe-cli oracle (verified 2026-09-26 against a local build of 1.25.0)
- Build: `scripts/oracle/build-pwsafe-cli.sh` (Ubuntu 24.04, packages in `scripts/oracle/apt-deps.txt`).
  The CLI has no `--version` flag; the build script checks the commit SHA instead.
- Needs a UTF-8 locale (`LC_ALL=C.UTF-8`), otherwise it refuses to run.
- Passphrase: read from stdin when not a terminal (it prints a harmless "Couldn't turn off echo").
  Never use `--passphrase`.
- Flags: `--create`; `--add=Field=value,...` with field names `Title`, `Username`, `Password`,
  `URL`, `Group`, `Notes`, `e-mail` (full list in `pwsafe-cli --help`); `--export=FILE --xml`
  (the `=` is required, without it output goes to stdout); `--import=FILE --xml`.
- XML import needs `pwsafe.xsd` in the directory named by `PWS_XMLDIR` (trailing slash).
- A new safe made by the CLI is format `0x0311` (`FromDatabaseFormat="3.17"` in its XML).
- **Quirk for WP8:** in a local test, exporting a title containing a space and importing that XML
  into another safe turned `Example Bank` into `Example.Bank`. Investigate before using the import
  direction as an oracle for values with spaces.

## pypwsafe (test input only)
- Repository: https://github.com/ronys/pypwsafe, commit `05ae8a2f7de07e1606d062a0135c43ffc0b0e22c`, GPLv2.
- Used only as a design reference and for its 8 test safes, downloaded at test time
  (`scripts/fetch-pypwsafe-fixtures.mjs`). No code is copied from it.

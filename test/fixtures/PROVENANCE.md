# Test fixture provenance

Every file under `test/fixtures/` is listed here with how it was made. Real password databases and
real passwords are never committed.

## Committed fixtures (`test/fixtures/generated/`)

Files we create ourselves, with our own made-up content, using the pinned `pwsafe-cli` oracle
(Password Safe 1.25.0, see `docs/references.md`) or by hand in the Password Safe app. Each has an
`*.expected.json` next to it, written independently of our parser.

| File | Made with | Contents | Password |
| ---- | --------- | -------- | -------- |
| `cli-add.psafe3` | `pwsafe-cli` 1.25.0: `--create`, then 13 × `--add=` | 13 entries: special characters, nested groups `a.b.c`, a group with a literal dot (`Dotted\.Name.Sub`), Unicode and emoji, an entry with only title and password (all other fields empty), explicit times, password history, 2FA key, run command / DCA / symbols / autotype, a protected entry, two entries with the same title in different groups | `wp8-fixture-add` |
| `cli-import.psafe3` | `pwsafe-cli` 1.25.0: `--create`, then `--import=… --xml` | 6 entries with fixed UUIDs: multi-line notes (CRLF, including an empty line), `,` `;` `]]>` `<` `&` inside values (which `--add` cannot carry), an empty `<username>` element, a 9,900-character note, emoji/CJK/accents in group, title, username, password and notes, a literal-dot group | `wp8-fixture-import` |
| `cli-many.psafe3` | `pwsafe-cli` 1.25.0: `--create`, then `--import=… --xml` | 250 entries with fixed UUIDs in 30 nested groups (`Many.Group n.Sub m`), some with username, URL, email and two-line notes | `wp8-fixture-many` |
| `cli-links.psafe3` | `pwsafe-cli` 1.25.0: `--create`, 3 × `--add=`, `--export=… --xml` (to read the base UUIDs), then 2 × `--add=` | 3 normal entries, an alias `[[uuid]]` and a shortcut `[~uuid~]` of two of them | `wp8-fixture-links` |

All four are made by `test/fixtures/make-generated.mjs` (run from the repository root):

```sh
PWSAFE_CLI=.oracle/pwsafe-cli PWS_XMLDIR=$PWD/.oracle/xml/ node test/fixtures/make-generated.mjs
```

It runs `pwsafe-cli` with `LC_ALL=C.UTF-8` and `TZ=UTC`, and writes the passphrase to the CLI's
stdin (twice for `--create`), never as `--passphrase`. The exact input values are the tables
`ADD_ENTRIES`, `IMPORT_ENTRIES` and `MANY_ENTRIES` in that script. For each file it runs:

- `cli-add.psafe3`:
  ```sh
  pwsafe-cli cli-add.psafe3 --create
  pwsafe-cli cli-add.psafe3 '--add=Title=Example Bank,Username=jordan.example,Password=p&<>"q'"'"'x!,Group=Banking.Online,URL=https://bank.example.com/login?a=1&b=2,e-mail=jordan@example.com,Notes=Single line note with <xml> & "quotes"'
  pwsafe-cli cli-add.psafe3 '--add=Title=Nested,Password=nested-pw,Group=a.b.c,Username=deep'
  pwsafe-cli cli-add.psafe3 '--add=Title=Literal dot group,Password=dot-pw,Group=Dotted\.Name.Sub'
  pwsafe-cli cli-add.psafe3 '--add=Title=Leading dot title .x,Password=x.y.z,Group=Top'
  pwsafe-cli cli-add.psafe3 '--add=Title=Unicode ü 日本語 🔑,Password=pä$$wörd🔐,Group=Grüße.日本,Username=Zoë,Notes=Ελληνικά עברית العربية'
  pwsafe-cli cli-add.psafe3 '--add=Title=Minimal,Password=only-password'
  pwsafe-cli cli-add.psafe3 '--add=Title=Times,Password=timed,Created Time=2024/01/02 03:04:05,Password Modified Time=2024/02/03 04:05:06,Record Modified Time=2024/03/04 05:06:07,Password Expiry Date=2030/05/06 07:08:09'
  pwsafe-cli cli-add.psafe3 '--add=Title=With history,Password=current,History=1030165f0a1b20004abcd'
  pwsafe-cli cli-add.psafe3 '--add=Title=With 2FA,Password=totp-pw,Two Factor Key=JBSWY3DPEHPK3PXP,Authentication Code Length=8'
  pwsafe-cli cli-add.psafe3 '--add=Title=Extras,Password=extras-pw,Run Command=echo hi,DCA=3,Symbols=#$,AutoType=\u\t\p\n'
  pwsafe-cli cli-add.psafe3 '--add=Title=Protected entry,Password=prot-pw,Protected=1'
  pwsafe-cli cli-add.psafe3 '--add=Title=Same title,Password=first,Group=Dup'
  pwsafe-cli cli-add.psafe3 '--add=Title=Same title,Password=second,Group=Dup2'
  pwsafe-cli cli-add.psafe3 --export=cli-add.psafe3.xml --xml   # read back the UUIDs, then deleted
  ```
- `cli-import.psafe3` and `cli-many.psafe3`: the script writes the table as Password Safe XML
  (`delimiter="^"`, each CRLF in notes written as `^`, `]]>` split across CDATA sections), then:
  ```sh
  pwsafe-cli cli-import.psafe3 --create
  pwsafe-cli cli-import.psafe3 --import=cli-import.psafe3.in.xml --xml
  pwsafe-cli cli-import.psafe3 --export=cli-import.psafe3.xml --xml   # cross-check, then deleted
  ```
- `cli-links.psafe3`:
  ```sh
  pwsafe-cli cli-links.psafe3 --create
  pwsafe-cli cli-links.psafe3 '--add=Title=Alias base,Password=alias-base-pw,Username=ab,Group=Links'
  pwsafe-cli cli-links.psafe3 '--add=Title=Shortcut base,Password=shortcut-base-pw,Username=sb,Group=Links'
  pwsafe-cli cli-links.psafe3 '--add=Title=Plain,Password=plain-pw,Group=Links'
  pwsafe-cli cli-links.psafe3 --export=cli-links.psafe3.xml --xml   # base UUIDs, then deleted
  pwsafe-cli cli-links.psafe3 '--add=Title=The alias,Password=[[<Alias base UUID>]],Group=Links'
  pwsafe-cli cli-links.psafe3 '--add=Title=The shortcut,Password=[~<Shortcut base UUID>~],Group=Links'
  ```

**Expected values.** Each `*.expected.json` is written from those input tables, not from our
parser. The only values taken from the CLI are the UUIDs it assigns on `--add`, read from its own
XML export; before writing, the script checks every value in that export against the table and
stops on any difference. The CLI's XML export crashes once a safe has aliases or shortcuts
(`docs/references.md`), and `--print` has no UUID field, so the alias and shortcut UUIDs are
`null` in `cli-links.expected.json` (the tests match those two entries on group and title).
`iterations` is the CLI's default (327,680), read from offset 36 of the file.

**Reproducibility.** Rerunning the script gives the same decoded values, and the same UUIDs for
the two imported files. Salt, keys, padding and the `--add` UUIDs are random, so the file bytes
differ on every run. The oracle test `test/oracle/cli-to-ours.test.ts` reruns the script in a
temp directory and checks the fresh files against their fresh and the committed JSON.

**What the CLI cannot make.** `--add` cannot set a value containing `,` or `;`, an empty value or
a line break, and always assigns its own UUID; the XML importer skips entries with an empty title
or password. Attachments, passkeys, credit-card fields, custom fields, unknown field types,
records missing mandatory fields, duplicate fields and invalid UTF-8 cannot be made with the CLI
and are covered by synthetic files in `src/main/psafe3/*.test.ts`.

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

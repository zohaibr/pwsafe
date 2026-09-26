# Working in this repo

This is a password manager. Correctness and not losing user data matter more than speed.

## Read first

- `docs/execution-plan.md`: the specs (§A), UI behaviour (§B), file ownership (§C) and work packages (§D).
  If code and the plan disagree, the plan wins; raise it with the lead rather than changing the spec.
- `docs/references.md`: pinned upstream revisions and verified `pwsafe-cli` behaviour.

## Rules

- Only edit files your work package owns (§C). `src/shared/**`, root configs, `package.json`,
  the lockfile, `.github/workflows/ci.yml`, `scripts/oracle/**` and `docs/references.md` need the lead.
- Do not add npm dependencies. If you need one, stop and say why.
- Never commit real `.psafe3` files or real passwords. Test files go in `test/fixtures/generated/`
  with an `*.expected.json` and a row in `test/fixtures/PROVENANCE.md`.
- No network calls from the app and no telemetry.
- Do not copy code from pypwsafe (GPLv2). Write from the format spec.
- The renderer never imports Node or Electron; shared code (`src/shared`) imports neither.
- Never log secrets, decrypted data or passphrases, including in tests and CI.

## Before you push

`npm run lint && npm run typecheck && npm test` must pass. UI changes also need
`npm run test:e2e` (Linux: `xvfb-run -a npm run test:e2e`).

## Conventions

- TypeScript strict, no `any`. Prettier: no semicolons, single quotes, width 100.
- Errors cross IPC as `Result` values (`src/shared/errors.ts`); nothing throws across IPC.
- Tests sit next to the code as `*.test.ts(x)`. Component tests add `// @vitest-environment jsdom`.

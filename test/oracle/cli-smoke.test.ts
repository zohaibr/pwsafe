// WP0 smoke test for the compatibility oracle: proves the flag spellings and stdin passphrase
// handling of pwsafe-cli 1.25.0 before WP8 relies on them (docs/execution-plan.md §A2, WP0).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hasOracle, runCli } from './pwsafeCli'

describe.skipIf(!hasOracle)('pwsafe-cli oracle smoke test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-smoke-'))
  const pass = 'oracle-smoke-pass'
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('creates a safe with the passphrase on stdin', () => {
    const run = runCli(['a.psafe3', '--create'], [pass, pass], dir)
    expect(run.status, run.stderr).toBe(0)
  })

  it('adds an entry with --add=Field=value', () => {
    const fields = [
      'Title=Example',
      'Username=jordan',
      'Password=p&<>"q',
      'Group=Banking.Online',
      'URL=https://bank.example.com',
      'e-mail=j@example.com',
      'Notes=line one',
    ].join(',')
    const run = runCli(['a.psafe3', `--add=${fields}`], [pass], dir)
    expect(run.status, run.stderr).toBe(0)
  })

  it('exports XML to a file with --export=FILE --xml and the values survive', () => {
    const run = runCli(['a.psafe3', '--export=a.xml', '--xml'], [pass], dir)
    expect(run.status, run.stderr).toBe(0)
    const xml = readFileSync(join(dir, 'a.xml'), 'utf8')
    expect(xml).toContain('<title><![CDATA[Example]]></title>')
    expect(xml).toContain('<username><![CDATA[jordan]]></username>')
    expect(xml).toContain('<password><![CDATA[p&<>"q]]></password>')
    expect(xml).toContain('<group><![CDATA[Banking.Online]]></group>')
    expect(xml).toContain('<email><![CDATA[j@example.com]]></email>')
    expect(xml).toContain('FromDatabaseFormat="3.17"')
  })

  it('imports XML with --import=FILE --xml into a new safe', () => {
    expect(runCli(['b.psafe3', '--create'], [pass, pass], dir).status).toBe(0)
    const run = runCli(['b.psafe3', '--import=a.xml', '--xml'], [pass], dir)
    expect(run.status, run.stderr).toBe(0)
    expect(runCli(['b.psafe3', '--export=b.xml', '--xml'], [pass], dir).status).toBe(0)
    const xml = readFileSync(join(dir, 'b.xml'), 'utf8')
    expect(xml).toContain('<username><![CDATA[jordan]]></username>')
    expect(xml).toContain('<password><![CDATA[p&<>"q]]></password>')
  })

  it('rejects a wrong passphrase with a non-zero exit', () => {
    const run = runCli(['a.psafe3', '--export=c.xml', '--xml'], ['wrong-pass'], dir)
    expect(run.status).not.toBe(0)
  })
})

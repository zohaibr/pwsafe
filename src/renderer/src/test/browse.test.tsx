// @vitest-environment jsdom
// Browse, detail, editor and delete: §B4, §B5, §B6, §B7, §B8 and §A3 badges.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { CLIPBOARD_CLEAR_MS, SIDEBAR_COLLAPSE_WIDTH } from '@shared/limits'
import { DELETE_BACKUP_TEXT } from '../dialogs/SimpleDialogs'
import {
  button,
  buttons,
  byRole,
  cleanup,
  click,
  dialog,
  field,
  flush,
  openFile,
  option,
  press,
  queryButton,
  queryDialog,
  queryRole,
  renderApp,
  text,
  type,
} from './harness'

afterEach(async () => {
  vi.useRealTimers()
  await cleanup()
  setWidth(1280)
})

// Test-only: Vitest serves CSS imports as empty strings, so read the stylesheet from disk. This runs
// in Node under Vitest; renderer code never touches the file system. (Non-literal specifier so the
// web tsconfig, which has no Node types, doesn't try to type it.)
const fsModule = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync(path: string, encoding: 'utf8'): string
}
const css = readFileSync('src/renderer/src/styles.css', 'utf8')
const passwordCell = () => document.querySelector('[data-testid="password-value"]')?.textContent
const seconds = () => document.querySelector('[data-testid="clipboard-seconds"]')?.textContent

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
  window.dispatchEvent(new Event('resize'))
}

describe('§A4.8 data flow in the renderer', () => {
  it('lists carry no passwords; nothing secret is in the page until an explicit reveal', async () => {
    const h = await renderApp()
    await openFile()
    const list = await h.api.listEntries()
    expect(list.ok && list.value.every((e) => e.password === '')).toBe(true)
    await click(option('Example Bank'))
    expect(text()).not.toContain('demo-Kq7!vR2p-sample')
    expect(h.controls.calls).not.toContain('revealPassword')
  })
})

describe('§B6 reveal', () => {
  it('masked by default; Show reveals; selecting another entry masks again', async () => {
    await renderApp()
    await openFile()
    await click(option('Example Bank'))
    expect(passwordCell()).toContain('••••')
    const show = button('Show password')
    expect(show.getAttribute('aria-pressed')).toBe('false')
    await click(show)
    expect(passwordCell()).toBe('demo-Kq7!vR2p-sample')
    expect(button('Hide password').getAttribute('aria-pressed')).toBe('true')
    await click(button('Hide password'))
    expect(passwordCell()).toContain('••••')

    await click(button('Show password'))
    await click(option('Bookshop'))
    expect(passwordCell()).toContain('••••')
    await click(option('Example Bank'))
    expect(passwordCell()).toContain('••••')
  })

  it('an alias reveals its base entry’s password', async () => {
    await renderApp()
    await openFile()
    await click(option('Grocery app'))
    await click(button('Show password'))
    expect(passwordCell()).toBe('demo-groc-Pw3-sample')
    expect(text()).toContain('Alias of Grocery delivery')
  })

  it('the editor masks an existing password and only fetches it on Show', async () => {
    const h = await renderApp()
    await openFile()
    await click(option('Example Bank'))
    await click(button('Edit'))
    const pw = field('Password')
    expect(pw.type).toBe('password')
    expect(pw.value).toBe('')
    expect(pw.placeholder).toBe('Unchanged')
    expect(h.controls.calls).not.toContain('revealPassword')
    await click(button('Show password'))
    expect(field('Password').type).toBe('text')
    expect(field('Password').value).toBe('demo-Kq7!vR2p-sample')
  })

  it('closing the editor, and saving, reset to masked', async () => {
    await renderApp()
    await openFile()
    await click(option('Example Bank'))
    await click(button('Show password'))
    await click(button('Edit'))
    await click(button('Cancel'))
    expect(passwordCell()).toContain('••••')

    await click(button('Show password'))
    await click(button('Edit'))
    await type(field('Notes'), 'changed')
    await click(button('Save entry'))
    expect(passwordCell()).toContain('••••')

    await click(button('Show password'))
    await click(button('Save'))
    expect(passwordCell()).toContain('••••')
  })

  it('editing without touching the password keeps it; a new one is sent only when changed', async () => {
    const h = await renderApp()
    await openFile()
    const spy = vi.spyOn(h.api, 'saveEntry')
    await click(option('Bookshop'))
    await click(button('Edit'))
    await type(field('Username'), 'sam.reads2')
    await click(button('Save entry'))
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('password')
    await click(button('Edit'))
    await type(field('Password'), 'demo-new-sample')
    await click(button('Save entry'))
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ password: 'demo-new-sample' })
  })
})

describe('§B5 clipboard', () => {
  it('timer starts at copy, counts down, and restarts on a second copy', async () => {
    const h = await renderApp()
    await openFile()
    await click(option('Example Bank'))
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    await click(button('Copy password'))
    expect(h.controls.clipboard).toEqual({
      uuid: '5f2c1a6e-0001-4d1a-9a55-000000000001',
      field: 'password',
    })
    expect(text()).toContain('Password copied.')
    expect(seconds()).toBe(`Clears in ${CLIPBOARD_CLEAR_MS / 1000} s`)

    await act(async () => vi.advanceTimersByTime(10_000))
    expect(seconds()).toBe('Clears in 20 s')

    await click(button('Copy username'))
    expect(text()).toContain('Username copied.')
    expect(seconds()).toBe('Clears in 30 s')

    await act(async () => vi.advanceTimersByTime(30_000))
    expect(text()).toContain('Clipboard cleared.')
  })

  it('copy never puts the value in the renderer', async () => {
    const h = await renderApp()
    await openFile()
    await click(option('Example Bank'))
    await click(button('Copy password'))
    expect(h.controls.calls).not.toContain('revealPassword')
    expect(text()).not.toContain('demo-Kq7!vR2p-sample')
  })
})

describe('§B4 delete', () => {
  it('Delete key on a selected entry asks, with the exact backup wording', async () => {
    const h = await renderApp()
    await openFile()
    await click(option('Bookshop'))
    await press(byRole('listbox'), 'Delete')
    const d = dialog('Delete “Bookshop”?')
    expect(d.getAttribute('role')).toBe('alertdialog')
    expect(d.textContent).toContain(
      'Removed from the file when you save. Each save keeps the previous 3 versions as backups, which you can restore from File → Restore from backup.',
    )
    expect(DELETE_BACKUP_TEXT).toContain('previous 3 versions')
    expect(document.activeElement?.textContent).toBe('Cancel')
    await press(document.activeElement as Element, 'Escape')
    expect(queryDialog()).toBeNull()
    expect(h.controls.calls).not.toContain('deleteEntry')

    await click(button('Delete'))
    await click(button('Delete entry'))
    expect(h.controls.calls).toContain('deleteEntry')
    expect(queryRole('option', /^Bookshop/)).toBeNull()
  })

  it('a base entry with aliases cannot be deleted: "Other entries depend on this one"', async () => {
    await renderApp()
    await openFile()
    await click(option('Grocery delivery'))
    expect(button('Delete').disabled).toBe(true)
    expect(text()).toContain('Other entries depend on this one.')
    await press(byRole('listbox'), 'Delete')
    expect(dialog('This entry is read-only').textContent).toContain(
      'Other entries depend on this one.',
    )
  })
})

describe('§B7 window and keyboard', () => {
  it(`below ${SIDEBAR_COLLAPSE_WIDTH}px the groups sidebar collapses behind a toggle`, async () => {
    await renderApp()
    await openFile()
    expect(document.getElementById('groups-pane')).not.toBeNull()
    expect(queryButton('Show groups')).toBeNull()
    await act(async () => setWidth(SIDEBAR_COLLAPSE_WIDTH - 1))
    expect(document.getElementById('groups-pane')).toBeNull()
    const toggle = button('Show groups')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe('groups-pane')
    await click(toggle)
    expect(document.getElementById('groups-pane')).not.toBeNull()
    expect(button('Hide groups').getAttribute('aria-expanded')).toBe('true')
    await act(async () => setWidth(SIDEBAR_COLLAPSE_WIDTH))
    expect(document.getElementById('groups-pane')).not.toBeNull()
  })

  it('details pane never drops below 360px and the window minimum is 960px (CSS)', () => {
    expect(css).toMatch(/\.detail-pane\s*{[^}]*min-width:\s*360px/)
    expect(css).toMatch(/\.vault\s*{[^}]*min-width:\s*960px/)
  })

  it('a visible 2px focus ring is defined for every control', () => {
    expect(css).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid/)
  })

  it('every button has an accessible name, including icon-only ones', async () => {
    await renderApp()
    await openFile()
    await click(option('Example Bank'))
    await act(async () => setWidth(1000))
    for (const b of buttons()) {
      const name = b.getAttribute('aria-label') ?? b.textContent?.trim()
      expect(name, b.outerHTML).toBeTruthy()
    }
  })

  it('Tab order: toolbar → groups → list → details', async () => {
    await renderApp()
    await openFile()
    await click(option('Example Bank'))
    const toolbar = document.querySelector('header.toolbar') as Element
    const groups = document.getElementById('groups-pane') as Element
    const list = byRole('listbox')
    const details = document.querySelector('.detail-pane') as Element
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(toolbar, groups)).toBe(true)
    expect(follows(groups, list)).toBe(true)
    expect(follows(list, details)).toBe(true)
    expect(
      document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])'),
    ).toHaveLength(0)
  })

  it('list: focus lands on it after unlock; arrows, Home and End move the selection', async () => {
    await renderApp()
    await openFile()
    const list = byRole('listbox')
    expect(document.activeElement).toBe(list)
    const selected = () => list.getAttribute('aria-activedescendant')
    await press(list, 'Home')
    const first = selected()
    await press(list, 'ArrowDown')
    expect(selected()).not.toBe(first)
    await press(list, 'ArrowUp')
    expect(selected()).toBe(first)
    await press(list, 'End')
    expect(document.getElementById(selected() ?? '')?.textContent).toContain('Router admin')
  })

  it('⌘F / Ctrl+F search, ⌘N new entry, ⌘S save, ⌘L lock', async () => {
    const h = await renderApp()
    await openFile()
    await press(window, 'f', { meta: true })
    expect(document.activeElement).toBe(field('Search entries'))
    await type(field('Search entries'), 'books')
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
    await type(field('Search entries'), '')

    await press(window, 'n', { ctrl: true })
    expect(document.querySelector('form.editor h2')?.textContent).toBe('New entry')
    await type(field('Title (required)'), 'Test entry')
    await click(button('Add entry'))
    expect(h.controls.state().dirtyCount).toBe(1)

    await press(window, 's', { meta: true })
    expect(h.controls.calls).toContain('save')
    expect(h.controls.state().dirtyCount).toBe(0)

    await press(window, 'l', { meta: true })
    expect(h.controls.state().status).toBe('locked')
  })

  it('shortcuts do nothing while a dialog is open', async () => {
    const h = await renderApp()
    await openFile()
    await click(option('Bookshop'))
    await click(button('Delete'))
    await press(window, 'l', { meta: true })
    expect(h.controls.state().status).toBe('open')
  })

  it('new entry needs a title; the error is announced and focus returns to the field', async () => {
    const h = await renderApp()
    await openFile()
    await click(button('New entry'))
    expect(document.activeElement).toBe(field('Title (required)'))
    await click(button('Add entry'))
    expect(text()).toContain('Enter a title.')
    expect(field('Title (required)').getAttribute('aria-invalid')).toBe('true')
    expect(h.controls.calls).not.toContain('saveEntry')
    await press(field('Title (required)'), 'Escape')
    expect(document.querySelector('form.editor')).toBeNull()
  })

  it('File menu closes with Escape and returns focus to its button', async () => {
    await renderApp()
    await openFile()
    await click(button('File'))
    expect(button('File').getAttribute('aria-expanded')).toBe('true')
    await press(button('Export XML…'), 'Escape')
    expect(button('File').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button('File'))
  })

  it('dialogs trap focus, make the page inert and give focus back on close', async () => {
    await renderApp()
    await openFile()
    await click(option('Bookshop'))
    const trigger = button('Delete')
    trigger.focus()
    await click(trigger)
    const d = dialog()
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(true)
    const inDialog = Array.from(d.querySelectorAll('button'))
    const last = inDialog[inDialog.length - 1] as HTMLButtonElement
    last.focus()
    await press(last, 'Tab')
    expect(document.activeElement).toBe(inDialog[0])
    await press(inDialog[0] as HTMLElement, 'Tab', { shift: true })
    expect(document.activeElement).toBe(last)
    await press(d, 'Escape')
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(button('Delete'))
  })
})

describe('§B8 read-only states and §A3 badges', () => {
  it.each([
    [
      'From-new-pwsafe.psafe3',
      'Made by a newer Password Safe; editing disabled to avoid losing data.',
    ],
    ['USB-stick.psafe3', "couldn't create a lock file"],
    ['Windows-copy.psafe3', 'On Windows this version'],
  ])('%s: read-only banner and no write actions', async (name, reason) => {
    await renderApp()
    await openFile(name)
    const banner = document.querySelector('[data-testid="readonly-banner"]')
    expect(banner?.textContent).toContain(reason)
    expect(text()).toContain('Read-only')
    expect(button('New entry').disabled).toBe(true)
    expect(button('Save').disabled).toBe(true)
    await click(option('Bookshop'))
    expect(button('Edit').disabled).toBe(true)
    expect(button('Delete').disabled).toBe(true)
    await click(button('File'))
    expect(button('Save As…').disabled).toBe(true)
    expect(button('Restore from backup…').disabled).toBe(true)
    expect(button('Export XML…').disabled).toBe(false)
    await click(button('File'))
    await click(button('Copy password'))
    expect(text()).toContain('Password copied.')
  })

  it('read-only records show a lock and the reason, with edit and delete off', async () => {
    await renderApp()
    await openFile()
    for (const [title, reason] of [
      ['Database admin', 'Protected in Password Safe'],
      ['Legacy intranet', 'two Title fields'],
      ['Family mail', 'Shortcut to another entry'],
    ] as const) {
      await click(option(title))
      expect(option(title).textContent).toContain('read-only')
      const note = document.querySelector('[data-testid="record-readonly"]')
      expect(note?.textContent).toContain(reason)
      expect(note?.querySelector('svg')).not.toBeNull()
      expect(button('Edit').disabled).toBe(true)
      expect(button('Delete').disabled).toBe(true)
    }
  })

  it('kept-but-hidden data shows badges', async () => {
    await renderApp()
    await openFile()
    await click(option('Example Bank'))
    expect(text()).toContain('Has 2FA (view in Password Safe)')
    expect(text()).toContain('Has password history (kept)')
    expect(text()).toContain('3 more fields are kept unchanged when you save.')
    await click(option('build-server-01'))
    expect(text()).toContain('Has attachment (kept)')
  })

  it('network drive and recovery banners show and can be dismissed', async () => {
    await renderApp()
    await openFile('Household.psafe3')
    expect(text()).toContain('File is on a network drive; make sure no one else has it open.')
    await click(button('Dismiss message'))
    expect(text()).not.toContain('File is on a network drive')
  })
})

describe('group tree', () => {
  it('filters by group including subgroups; escaped dots display as one name', async () => {
    await renderApp()
    await openFile()
    await click(button(/^Personal \d+ entries$/))
    expect(document.querySelectorAll('[role="option"]').length).toBe(7)
    await click(button('Collapse Personal'))
    expect(queryButton(/^Banking/)).toBeNull()
    await click(button('Expand Personal'))
    await click(button(/^Banking/))
    expect(document.querySelectorAll('[role="option"]').length).toBe(2)
    expect(queryButton(/^Work\.old 1 entries$/)).not.toBeNull()
    expect(button(/^Banking/).getAttribute('aria-current')).toBe('true')
    await flush()
  })
})

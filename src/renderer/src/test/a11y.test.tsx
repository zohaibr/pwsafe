// @vitest-environment jsdom
// axe-core scan of every screen and dialog: zero serious or critical violations.
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import axe from 'axe-core'
import {
  button,
  cleanup,
  click,
  expectNoSeriousA11yViolations as scan,
  field,
  flush,
  openFile,
  option,
  renderApp,
  type,
  waitFor,
} from './harness'

afterEach(cleanup)

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
  window.dispatchEvent(new Event('resize'))
}

describe('axe in jsdom', () => {
  it('does catch a serious problem (sanity check of the scanner itself)', async () => {
    document.body.innerHTML = '<main><button></button><input type="text"></main>'
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual(expect.arrayContaining(['button-name', 'label']))
  })
})

describe('axe: start and unlock', () => {
  it('start screen, and an open error on it', async () => {
    await renderApp()
    await scan('start')
    await click(button(/^Newer-format\.psafe4/))
    await scan('start with UNSUPPORTED_FORMAT')
  })

  it('locked screen, wrong password, slow unlock progress', async () => {
    await renderApp({ slowUnlockTickMs: 50 })
    await click(button(/^Personal\.psafe3/))
    await scan('locked')
    await type(field('Master password'), 'nope')
    await click(button('Unlock'))
    await scan('wrong password')
    await click(button('Open a different file'))
    await click(button(/^Archive-2019/))
    await type(field('Master password'), 'demo')
    await click(button('Unlock'))
    await waitFor(() => {
      if (!document.querySelector('progress')) throw new Error('no progress yet')
    })
    await scan('slow unlock')
    await click(button('Cancel'))
  })

  it('file open in another app, and the remove-lock confirmation', async () => {
    await renderApp()
    await openFile('Team-shared.psafe3')
    await scan('locked by other')
    await click(button('Remove lock and open…'))
    await scan('remove lock confirm')
  })
})

describe('axe: vault', () => {
  it('browse, detail with revealed password and clipboard toast, file menu', async () => {
    await renderApp()
    await openFile()
    await scan('browse, nothing selected')
    await click(option('Example Bank'))
    await click(button('Show password'))
    await click(button('Copy password'))
    await scan('detail revealed + clipboard toast')
    await click(option('Grocery app'))
    await scan('alias entry')
    await click(button('File'))
    await scan('file menu')
  })

  it('editor with generator, and the title error', async () => {
    await renderApp()
    await openFile()
    await click(option('Example Bank'))
    await click(button('Edit'))
    await click(button('Generate…'))
    await scan('edit + generator')
    await click(button('Cancel'))
    await click(button('New entry'))
    await click(button('Add entry'))
    await scan('new entry with error')
  })

  it('delete, unsaved changes, conflict, save failed, durability toast', async () => {
    const h = await renderApp()
    await openFile()
    await click(option('Bookshop'))
    await click(button('Delete'))
    await scan('delete confirm')
    await click(button('Delete entry'))
    await click(button('Lock'))
    await scan('unsaved changes on lock')
    await click(button('Cancel'))
    h.controls.nextSave = 'conflict'
    await click(button('Save'))
    await scan('conflict')
    await click(button('Cancel'))
    h.controls.nextSave = 'failed'
    await click(button('Save'))
    await scan('save failed')
    await click(button('OK'))
    h.controls.nextSave = 'durability'
    await click(button('Save'))
    await scan('durability warning')
  })

  it('restore (list and preview), export (dialog and toast), settings', async () => {
    await renderApp()
    await openFile()
    await click(button('File'))
    await click(button('Restore from backup…'))
    await scan('restore list')
    await type(field('Master password of this backup'), 'demo')
    await click(button('Preview'))
    await scan('restore preview')
    await click(button('Cancel'))
    await click(button('File'))
    await click(button('Export XML…'))
    await scan('export')
    await click(field(/^I understand/))
    await click(button('Export…'))
    await scan('export done toast')
    await click(button('File'))
    await click(button('Settings…'))
    await scan('settings')
  })

  it('read-only file banner and read-only record', async () => {
    await renderApp()
    await openFile('From-new-pwsafe.psafe3')
    await click(option('Database admin'))
    await scan('read-only file and record')
  })

  it('info and warning banners', async () => {
    await renderApp()
    await openFile('Messy-backups.psafe3')
    await scan('backup unknown-state banner')
  })

  it('narrow window: sidebar collapsed and opened', async () => {
    await renderApp()
    await openFile()
    await act(async () => setWidth(1000))
    await scan('narrow collapsed')
    await click(button('Show groups'))
    await scan('narrow open')
  })

  it('quit dialogs: with unsaved changes, and while locked', async () => {
    const h = await renderApp()
    await openFile()
    await click(option('Bookshop'))
    await click(button('Delete'))
    await click(button('Delete entry'))
    await act(async () => h.controls.requestClose('quit'))
    await flush()
    await scan('quit with unsaved')
    await click(button('Cancel'))
    await act(async () => h.controls.autoLock())
    await flush()
    await act(async () => h.controls.requestClose('quit'))
    await flush()
    await scan('quit while locked')
  })
})

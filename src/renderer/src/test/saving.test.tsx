// @vitest-environment jsdom
// §A5 save outcomes, Save As, restore from backup and §A7 export, all driven from the mock.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MESSAGES, ErrorCode } from '@shared/errors'
import { ERROR_PRESENTATION, presentError } from '../errorText'
import {
  button,
  cleanup,
  click,
  dialog,
  field,
  openFile,
  option,
  queryButton,
  queryDialog,
  renderApp,
  text,
  type,
  type Harness,
} from './harness'

afterEach(cleanup)

const dirty = () => document.querySelector('[data-testid="dirty-count"]')?.textContent ?? null

async function openWithEdit(): Promise<Harness> {
  const h = await renderApp()
  await openFile()
  await click(option('Bookshop'))
  await click(button('Edit'))
  await type(field('Notes'), 'Edited in a test.')
  await click(button('Save entry'))
  return h
}

describe('every error code has a designed message state', () => {
  it.each(Object.values(ErrorCode))('%s', (code) => {
    const p = ERROR_PRESENTATION[code]
    expect(p.title.length).toBeGreaterThan(0)
    expect(['error', 'warning', 'info']).toContain(p.tone)
    const shown = presentError({ code, message: DEFAULT_MESSAGES[code], detail: 'extra' })
    expect(shown.body).toBe(`${DEFAULT_MESSAGES[code]} extra`)
  })
})

describe('§A5 save outcomes', () => {
  it('ok: saved toast, unsaved count cleared', async () => {
    await openWithEdit()
    expect(dirty()).toBe('Unsaved changes (1)')
    await click(button('Save'))
    expect(dirty()).toBeNull()
    expect(text()).toContain('Saved.')
    expect(button('Save').disabled).toBe(true)
  })

  it('rows 1 and 6: conflict dialog offers Save As…, Reload (discard my changes), Cancel', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'conflict'
    await click(button('Save'))
    const d = dialog('The file was changed by another app')
    expect(Array.from(d.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Save As…',
      'Reload (discard my changes)',
      'Cancel',
    ])
    await click(button('Cancel'))
    expect(queryDialog()).toBeNull()
    expect(dirty()).toBe('Unsaved changes (1)')
  })

  it('conflict → Reload discards the changes', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'conflict'
    await click(button('Save'))
    await click(button('Reload (discard my changes)'))
    expect(queryDialog()).toBeNull()
    expect(dirty()).toBeNull()
    expect(h.controls.calls).toContain('reloadFromDisk')
  })

  it('conflict → Save As onto a file open elsewhere is refused and the dialog stays', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'conflict'
    h.controls.nextSaveAs = 'locked'
    await click(button('Save'))
    await click(button('Save As…'))
    const d = dialog('The file was changed by another app')
    expect(d.textContent).toContain('That file is open in another app.')
    expect(dirty()).toBe('Unsaved changes (1)')
  })

  it('conflict → Save As cancelled in the native dialog keeps the conflict dialog', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'conflict'
    h.controls.nextSaveAs = 'cancel'
    await click(button('Save'))
    await click(button('Save As…'))
    expect(queryDialog('The file was changed by another app')).not.toBeNull()
  })

  it('conflict → Save As succeeds: the new file becomes active', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'conflict'
    await click(button('Save'))
    await click(button('Save As…'))
    expect(queryDialog()).toBeNull()
    expect(document.querySelector('h1')?.textContent).toBe('Personal (copy).psafe3')
    expect(text()).toContain('Saved as Personal (copy).psafe3.')
  })

  it('rows 2–5 and 7: save failed with the step, file and backups unchanged, edits kept', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'failed'
    await click(button('Save'))
    const d = dialog('Save failed')
    expect(d.textContent).toContain('Step 4: the new file could not be read back from disk.')
    expect(d.textContent).toContain('Your file and its backups on disk are exactly as they were.')
    await click(button('OK'))
    expect(dirty()).toBe('Unsaved changes (1)')
  })

  it('row 8: saved, backup rotation unfinished → info banner', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'rotation-incomplete'
    await click(button('Save'))
    expect(dirty()).toBeNull()
    expect(text()).toContain(
      "Saved. Backup rotation didn't finish; it will complete next time you open this file.",
    )
  })

  it('row 9: durability unconfirmed is a warning, not a failed save', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'durability'
    await click(button('Save'))
    expect(queryDialog()).toBeNull()
    expect(dirty()).toBeNull()
    const toast = document.querySelector('[data-testid="notice-toast"]')
    expect(toast?.textContent).toContain(DEFAULT_MESSAGES.SAVED_DURABILITY_UNCONFIRMED)
    expect(toast?.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('I/O error during save shows its message', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'io-error'
    await click(button('Save'))
    expect(dialog("Couldn't read or write the file").textContent).toContain('The disk is full.')
  })

  it('File → Save As… failure is shown in an error dialog', async () => {
    const h = await openWithEdit()
    h.controls.nextSaveAs = 'failed'
    await click(button('File'))
    await click(button('Save As…'))
    expect(dialog('Save failed').textContent).toContain('Step 3: permission denied.')
  })
})

describe('restore from backup', () => {
  it('lists backups, needs the backup password, previews read-only, then restores', async () => {
    const h = await renderApp()
    await openFile()
    await click(button('File'))
    await click(button('Restore from backup…'))
    const d = dialog('Restore from backup')
    expect(d.querySelectorAll('input[type="radio"]')).toHaveLength(3)
    expect(d.textContent).toContain('.bak2')
    expect(button('Preview').disabled).toBe(true)

    await type(field('Master password of this backup'), 'wrong')
    await click(button('Preview'))
    expect(dialog().querySelector('[data-code="WRONG_PASSWORD"]')).not.toBeNull()

    await type(field('Master password of this backup'), 'demo')
    await click(button('Preview'))
    expect(dialog().textContent).toContain('Read-only.')
    expect(dialog().querySelectorAll('tbody tr').length).toBe(9)
    expect(dialog().textContent).not.toContain('demo-')

    await click(button('Restore this version'))
    expect(queryDialog()).toBeNull()
    expect(h.controls.calls).toContain('restoreBackup')
    expect(text()).toContain('Restored the backup.')
  })

  it('warns that unsaved changes are discarded by a restore', async () => {
    await openWithEdit()
    await click(button('File'))
    await click(button('Restore from backup…'))
    await type(field('Master password of this backup'), 'demo')
    await click(button('Preview'))
    expect(dialog().textContent).toContain('Your 1 unsaved change is discarded.')
  })
})

describe('§A7 export', () => {
  it('needs "I understand"; shows scope, omitted-field count and the plaintext warning', async () => {
    const h = await renderApp()
    await openFile()
    await click(button('File'))
    await click(button('Export XML…'))
    const d = dialog('Export to XML')
    expect(d.textContent).toContain('The exported file is not encrypted')
    expect(d.textContent).toContain('This app never deletes it for you.')
    expect(d.textContent).toContain(
      "3 entries have attachments, passkeys or custom fields that XML can't hold",
    )
    expect(button('Export…').disabled).toBe(true)
    expect(field(/^Current group/).disabled).toBe(true)
    await click(field(/^I understand/))
    expect(button('Export…').disabled).toBe(false)

    h.controls.nextExport = 'cancel'
    await click(button('Export…'))
    expect(queryDialog('Export to XML')).not.toBeNull()

    const reveal = vi.spyOn(h.api, 'revealInFolder')
    await click(button('Export…'))
    expect(queryDialog()).toBeNull()
    const toast = document.querySelector('[data-testid="notice-toast"]')
    expect(toast?.textContent).toMatch(
      /Exported 14 entries to ~\/Downloads\/Personal-export-\d{8}\.xml/,
    )
    expect(toast?.textContent).toContain('delete it when you no longer need it')
    const revealButton = queryButton('Reveal in Finder') ?? button('Show in folder')
    await click(revealButton)
    expect(reveal).toHaveBeenCalledWith(expect.stringMatching(/\.xml$/))
  })

  it('exports the current group with subgroups', async () => {
    const h = await renderApp()
    await openFile()
    const spy = vi.spyOn(h.api, 'exportXml')
    await click(button(/^Personal \d+ entries$/))
    await click(button('File'))
    await click(button('Export XML…'))
    expect(field(/^Current group/).checked).toBe(true)
    expect(dialog().textContent).toContain('Current group: Personal, with subgroups (7)')
    await click(field(/^I understand/))
    await click(button('Export…'))
    expect(spy).toHaveBeenCalledWith({ scope: { kind: 'group', path: 'Personal' } })
    expect(text()).toContain('Exported 7 entries')
  })

  it('an export error stays in the dialog', async () => {
    const h = await renderApp()
    await openFile()
    h.controls.nextExport = 'io-error'
    await click(button('File'))
    await click(button('Export XML…'))
    await click(field(/^I understand/))
    await click(button('Export…'))
    expect(dialog('Export to XML').textContent).toContain('The folder is not writable.')
  })
})

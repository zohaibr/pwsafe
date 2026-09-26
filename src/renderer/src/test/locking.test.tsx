// @vitest-environment jsdom
// §B2 locking and settings, §B3 unsaved changes (lock, close, open another, quit, quit while locked).
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { IDLE_LOCK_DEFAULT_MIN } from '@shared/limits'
import {
  button,
  cleanup,
  click,
  dialog,
  field,
  flush,
  openFile,
  option,
  press,
  queryDialog,
  renderApp,
  submit,
  text,
  type,
  type Harness,
} from './harness'

afterEach(cleanup)

const dirty = () => document.querySelector('[data-testid="dirty-count"]')?.textContent ?? null

/** Opens Personal.psafe3 and makes one in-memory edit. */
async function openWithEdit(): Promise<Harness> {
  const h = await renderApp()
  await openFile()
  await click(option('Bookshop'))
  await click(button('Edit'))
  await type(field('Notes'), 'Edited in a test.')
  await click(button('Save entry'))
  expect(dirty()).toBe('Unsaved changes (1)')
  return h
}

describe('§B2 locking', () => {
  it('locked screen shows the file name, the master password field and Unlock', async () => {
    const h = await renderApp()
    await openFile()
    await click(button('Lock'))
    expect(h.controls.state().status).toBe('locked')
    expect(document.querySelector('h1')?.textContent).toBe('Personal.psafe3')
    expect(field('Master password').type).toBe('password')
    expect(button('Unlock')).toBeTruthy()
  })

  it('on lock the renderer drops all entry state and visible values', async () => {
    const h = await renderApp()
    await openFile()
    await click(option('Example Bank'))
    await click(button('Show password'))
    expect(text()).toContain('demo-Kq7!vR2p-sample')
    await click(button('Copy username'))
    expect(document.querySelector('[data-testid="clipboard-toast"]')).not.toBeNull()

    await act(async () => h.controls.autoLock())
    await flush()
    const body = text()
    expect(body).not.toContain('demo-Kq7!vR2p-sample')
    expect(body).not.toContain('Example Bank')
    expect(body).not.toContain('sam.demo')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.querySelector('[data-testid="clipboard-toast"]')).toBeNull()

    // After unlocking, the password is masked again.
    await type(field('Master password'), 'demo')
    await click(button('Unlock'))
    await click(option('Example Bank'))
    expect(text()).not.toContain('demo-Kq7!vR2p-sample')
  })

  it('settings: idle default 5 min within 1–60, lock on minimise off with the plan wording', async () => {
    const h = await renderApp()
    await openFile()
    await click(button('File'))
    await click(button('Settings…'))
    const minutes = field('Lock after being idle for')
    expect(minutes.value).toBe(String(IDLE_LOCK_DEFAULT_MIN))
    expect(minutes.min).toBe('1')
    expect(minutes.max).toBe('60')
    const minimise = field('Lock when the window is minimised')
    expect(minimise.checked).toBe(false)
    expect(text()).toContain('always locks when the computer sleeps or the screen locks')

    for (const bad of ['0', '61', '2.5']) {
      await type(minutes, bad)
      await submit(dialog('Settings').querySelector('form') as HTMLFormElement)
      expect(field('Lock after being idle for').getAttribute('aria-invalid')).toBe('true')
      expect(queryDialog('Settings')).not.toBeNull()
    }
    await type(field('Lock after being idle for'), '15')
    await click(field('Lock when the window is minimised'))
    await click(button('Save settings'))
    expect(queryDialog('Settings')).toBeNull()
    const s = await h.api.getSettings()
    expect(s.ok && s.value.idleLockMinutes).toBe(15)
    expect(s.ok && s.value.lockOnMinimize).toBe(true)
  })

  it('reports activity to main for the idle timer, throttled', async () => {
    const h = await renderApp()
    await openFile()
    const before = h.controls.calls.filter((c) => c === 'reportActivity').length
    await press(window, 'a')
    await press(window, 'b')
    const after = h.controls.calls.filter((c) => c === 'reportActivity').length
    expect(after - before).toBeLessThanOrEqual(1)
  })
})

describe('§B3 unsaved changes', () => {
  it('pending deletes count as unsaved changes', async () => {
    await renderApp()
    await openFile()
    await click(option('Bookshop'))
    await click(button('Delete'))
    await click(button('Delete entry'))
    expect(dirty()).toBe('Unsaved changes (1)')
    await click(option('Home Wi-Fi'))
    await click(button('Delete'))
    await click(button('Delete entry'))
    expect(dirty()).toBe('Unsaved changes (2)')
  })

  it('auto-lock keeps the changes; after unlock they are back and still unsaved', async () => {
    const h = await openWithEdit()
    await act(async () => h.controls.autoLock())
    await flush()
    expect(h.controls.calls).not.toContain('save')
    await type(field('Master password'), 'demo')
    await click(button('Unlock'))
    expect(dirty()).toBe('Unsaved changes (1)')
  })

  it('manual lock asks Save / Don’t save / Cancel; Cancel keeps everything', async () => {
    const h = await openWithEdit()
    await click(button('Lock'))
    const d = dialog('Save changes before locking?')
    expect(d.getAttribute('role')).toBe('alertdialog')
    expect(Array.from(d.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Save',
      "Don't save",
      'Cancel',
    ])
    await click(button('Cancel'))
    expect(h.controls.state().status).toBe('open')
    expect(dirty()).toBe('Unsaved changes (1)')
  })

  it('manual lock → Save saves, then locks', async () => {
    const h = await openWithEdit()
    await click(button('Lock'))
    await click(button('Save'))
    const calls = h.controls.calls
    expect(calls.lastIndexOf('save')).toBeGreaterThan(-1)
    expect(calls.lastIndexOf('lock')).toBeGreaterThan(calls.lastIndexOf('save'))
    expect(h.controls.state().status).toBe('locked')
  })

  it('manual lock → Save that hits a conflict does not lock and shows the conflict', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'conflict'
    await click(button('Lock'))
    await click(button('Save'))
    expect(h.controls.state().status).toBe('open')
    expect(dialog('The file was changed by another app')).toBeTruthy()
  })

  it("manual lock → Don't save discards the changes and locks", async () => {
    const h = await openWithEdit()
    await click(button('Lock'))
    await click(button("Don't save"))
    expect(h.controls.calls).toContain('reloadFromDisk')
    expect(h.controls.calls).not.toContain('save')
    expect(h.controls.state().status).toBe('locked')
    expect(h.controls.state().dirtyCount).toBe(0)
  })

  it('Close file with unsaved changes asks first', async () => {
    const h = await openWithEdit()
    await click(button('File'))
    await click(button('Close file'))
    expect(dialog('Save changes before closing?')).toBeTruthy()
    await click(button("Don't save"))
    expect(h.controls.state().status).toBe('no-file')
  })

  it('Open another file with unsaved changes asks first; cancelling the picker keeps the edits', async () => {
    const h = await openWithEdit()
    h.controls.chooseFileResult = null
    await click(button('File'))
    await click(button('Open another file…'))
    expect(dialog('Save changes before opening another file?')).toBeTruthy()
    await click(button("Don't save"))
    expect(h.controls.calls).toContain('chooseFile')
    expect(h.controls.state().status).toBe('open')
    expect(dirty()).toBe('Unsaved changes (1)')
  })

  it('Quit with unsaved changes: Save / Don’t save / Cancel, answered to main', async () => {
    const h = await openWithEdit()
    await act(async () => h.controls.requestClose('quit'))
    expect(dialog('Save changes before quitting?')).toBeTruthy()
    await click(button('Cancel'))
    expect(h.controls.closeResponses).toEqual(['cancel'])

    await act(async () => h.controls.requestClose('close-window'))
    expect(dialog('Save changes before closing the window?')).toBeTruthy()
    await click(button("Don't save"))
    expect(h.controls.closeResponses).toEqual(['cancel', 'discard'])

    await act(async () => h.controls.requestClose('quit'))
    await click(button('Save'))
    expect(h.controls.calls).toContain('save')
    expect(h.controls.closeResponses).toEqual(['cancel', 'discard', 'save'])
  })

  it('Quit with a failing save answers cancel and shows the error', async () => {
    const h = await openWithEdit()
    h.controls.nextSave = 'failed'
    await act(async () => h.controls.requestClose('quit'))
    await click(button('Save'))
    expect(h.controls.closeResponses).toEqual(['cancel'])
    expect(dialog('Save failed').textContent).toContain('Step 4')
  })

  it('Quit with nothing unsaved goes ahead without asking', async () => {
    const h = await renderApp()
    await openFile()
    await act(async () => h.controls.requestClose('quit'))
    await flush()
    expect(queryDialog()).toBeNull()
    expect(h.controls.closeResponses).toEqual(['discard'])
  })

  it('Quit while locked: Unlock and save / Quit without saving / Cancel', async () => {
    const h = await openWithEdit()
    await act(async () => h.controls.autoLock())
    await flush()
    await act(async () => h.controls.requestClose('quit'))
    await flush()
    const d = dialog('The file is locked and has unsaved changes')
    expect(Array.from(d.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Unlock and save',
      'Quit without saving',
      'Cancel',
    ])
    await click(button('Quit without saving'))
    expect(h.controls.closeResponses).toEqual(['discard'])
  })

  it('Quit while locked → Unlock and save: unlock, save, then answer save', async () => {
    const h = await openWithEdit()
    await act(async () => h.controls.autoLock())
    await flush()
    await act(async () => h.controls.requestClose('quit'))
    await flush()
    await click(button('Unlock and save'))
    expect(text()).toContain('Unlock to save your changes. The app quits after saving.')
    await type(field('Master password'), 'demo')
    await click(button('Unlock'))
    await flush()
    expect(h.controls.calls.filter((c) => c === 'save')).toHaveLength(1)
    expect(h.controls.closeResponses).toEqual(['save'])
  })
})

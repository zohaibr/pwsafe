// @vitest-environment jsdom
// Start, unlock, slow unlock (§B9, §A1) and the open-time error states (§A4, §A6).
import { afterEach, describe, expect, it } from 'vitest'
import {
  button,
  cleanup,
  click,
  dialog,
  field,
  flush,
  openFile,
  queryButton,
  queryDialog,
  renderApp,
  text,
  type,
  waitFor,
} from './harness'

afterEach(cleanup)

describe('start screen', () => {
  it('shows the app heading and the no-file status the smoke test expects', async () => {
    await renderApp()
    const h1 = document.querySelector('h1')
    expect(h1?.textContent).toBe('psafe3 Opener')
    expect(document.querySelector('[data-testid="status"]')?.textContent).toBe('Status: no-file')
    expect(document.activeElement).toBe(button(/Open a file/))
  })

  it('lists recent files and opens the chosen one to the locked screen', async () => {
    const h = await renderApp()
    expect(text()).toContain('Recent files')
    await click(button(/^Personal\.psafe3/))
    expect(h.controls.state().status).toBe('locked')
    expect(document.querySelector('h1')?.textContent).toBe('Personal.psafe3')
    expect(document.activeElement).toBe(field('Master password'))
  })

  it('native Open dialog cancel leaves the start screen as it was', async () => {
    const h = await renderApp({ chooseFileResult: null })
    await click(button(/Open a file/))
    expect(h.controls.state().status).toBe('no-file')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it.each([
    ['Newer-format.psafe4', 'UNSUPPORTED_FORMAT', 'V4 files are not supported'],
    ['Huge.psafe3', 'TOO_LARGE', 'too large'],
    ['Unreadable.psafe3', 'IO_ERROR', 'The drive is not connected.'],
  ])('%s shows its %s message before any password is asked', async (name, code, msg) => {
    await renderApp()
    await click(button(new RegExp(`^${name.replace('.', '\\.')}`)))
    const alert = document.querySelector(`[data-code="${code}"]`)
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toContain(msg)
  })
})

describe('unlock', () => {
  it('wrong password: says so, mentions YubiKey, clears and refocuses the field', async () => {
    const h = await renderApp()
    await click(button(/^Personal\.psafe3/))
    await type(field('Master password'), 'nope')
    await click(button('Unlock'))
    await flush()
    const alert = document.querySelector('[data-code="WRONG_PASSWORD"]')
    expect(alert?.textContent).toContain('Wrong master password')
    expect(alert?.textContent).toContain('YubiKey')
    expect(field('Master password').value).toBe('')
    expect(field('Master password').getAttribute('aria-invalid')).toBe('true')
    expect(h.controls.state().status).toBe('locked')
  })

  it('right password opens the vault', async () => {
    const h = await renderApp()
    await openFile()
    expect(h.controls.state().status).toBe('open')
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="status"]')?.textContent).toBe('Status: open')
  })

  it.each([
    ['Damaged.psafe3', 'CORRUPT_FILE', 'damaged'],
    ['Tampered.psafe3', 'INTEGRITY_FAILED', 'integrity check'],
  ])('%s shows %s after the password', async (name, code, msg) => {
    await renderApp()
    await openFile(name)
    const alert = document.querySelector(`[data-code="${code}"]`)
    expect(alert?.textContent).toContain(msg)
  })

  it('§B9 slow file: progress bar with the long-unlock text, and Cancel stops it', async () => {
    const h = await renderApp({ slowUnlockTickMs: 20 })
    await click(button(/^Archive-2019/))
    await type(field('Master password'), 'demo')
    await click(button('Unlock'))
    await waitFor(() => expect(document.querySelector('progress')).not.toBeNull())
    expect(text()).toContain('This file uses extra-strong key stretching; unlocking takes longer.')
    expect(field('Master password').disabled).toBe(true)
    expect(document.activeElement).toBe(button('Cancel'))
    await waitFor(() =>
      expect(Number(document.querySelector('progress')?.getAttribute('value'))).toBeGreaterThan(0),
    )
    await click(button('Cancel'))
    await waitFor(() => expect(text()).toContain('Unlock cancelled.'))
    expect(h.controls.state().status).toBe('locked')
    expect(document.querySelector('progress')).toBeNull()
  })

  it('§B9 slow file finishes and opens', async () => {
    const h = await renderApp({ slowUnlockTickMs: 1 })
    await openFile('Archive-2019.psafe3')
    await waitFor(() => expect(h.controls.state().status).toBe('open'))
  })

  it('Open a different file goes back to the start screen', async () => {
    const h = await renderApp()
    await click(button(/^Personal\.psafe3/))
    await click(button('Open a different file'))
    expect(h.controls.state().status).toBe('no-file')
    expect(document.querySelector('h1')?.textContent).toBe('psafe3 Opener')
  })
})

describe('§A6 file open in another app', () => {
  it('shows the lock owner and offers read-only; never removes the lock without a second confirmation', async () => {
    const h = await renderApp()
    await openFile('Team-shared.psafe3')
    const d = dialog('This file is open in another app')
    expect(d.getAttribute('role')).toBe('alertdialog')
    expect(d.textContent).toContain('alex@studio-mac')
    expect(d.textContent).toContain('process 4312')

    await click(button('Remove lock and open…'))
    const confirm = dialog('Remove the lock?')
    expect(confirm.textContent).toContain(
      "Only do this if Password Safe isn't running with this file on alex@studio-mac",
    )
    expect(document.activeElement?.textContent).toBe('Cancel')
    await click(button('Cancel'))
    expect(queryDialog('Remove the lock?')).toBeNull()
    expect(h.controls.calls).not.toContain('unlockWithLockChoice')

    await click(button('Open read-only'))
    expect(h.controls.state().readOnly?.reason).toBe('locked-by-other')
    expect(document.querySelector('[data-testid="readonly-banner"]')).not.toBeNull()
  })

  it('remove lock and open, after confirming, opens for editing', async () => {
    const h = await renderApp()
    await openFile('Team-shared.psafe3')
    await click(button('Remove lock and open…'))
    await click(button('Remove lock and open'))
    expect(h.controls.state().status).toBe('open')
    expect(h.controls.state().readOnly).toBeUndefined()
  })

  it('without the pending API call only Cancel is offered', async () => {
    await renderApp({}, (api) => ({ ...api, unlockWithLockChoice: undefined }))
    await openFile('Team-shared.psafe3')
    expect(queryButton('Open read-only')).toBeNull()
    expect(queryButton('Remove lock and open…')).toBeNull()
    expect(dialog().textContent).toContain('Close the file in the other app')
    await click(button('Cancel'))
    expect(queryDialog()).toBeNull()
  })
})

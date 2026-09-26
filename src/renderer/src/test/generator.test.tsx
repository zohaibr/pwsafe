// @vitest-environment jsdom
// §B1 generator state, and the editor around it.
import { afterEach, describe, expect, it } from 'vitest'
import { GENERATOR_DEFAULT_LENGTH } from '@shared/limits'
import { entropyBits, strengthLabel } from '../strength'
import { DEFAULT_GENERATOR } from '../defaults'
import {
  button,
  cleanup,
  click,
  field,
  flush,
  openFile,
  renderApp,
  type,
  type Harness,
} from './harness'

afterEach(cleanup)

const preview = () =>
  (document.querySelector('[data-testid="generated-preview"]')?.textContent ?? '').replace(
    'Generated password: ',
    '',
  )
const strength = () =>
  document.querySelector('[data-testid="strength"]')?.getAttribute('data-strength')
const checkbox = (label: string | RegExp) => field(label)

async function openGenerator(): Promise<Harness> {
  const h = await renderApp()
  await openFile()
  await click(button('New entry'))
  await click(button('Generate…'))
  return h
}

describe('§B1 generator', () => {
  it('defaults: length 20, all four types on, look-alikes off, "at least one of each" on', async () => {
    await openGenerator()
    expect(Number(field('Length').value)).toBe(GENERATOR_DEFAULT_LENGTH)
    expect(checkbox(/^Uppercase/).checked).toBe(true)
    expect(checkbox(/^Lowercase/).checked).toBe(true)
    expect(checkbox(/^Digits/).checked).toBe(true)
    expect(checkbox(/^Symbols/).checked).toBe(true)
    expect(checkbox(/^Avoid look-alike/).checked).toBe(false)
    expect(checkbox('Use at least one of each selected type').checked).toBe(true)
  })

  it('preview and strength always follow the visible options', async () => {
    const h = await openGenerator()
    const last = () => h.generate.calls[h.generate.calls.length - 1]
    expect(last()).toEqual(DEFAULT_GENERATOR)
    expect(preview()).toMatch(/-Ul7#-20$/)
    expect(strength()).toBe(strengthLabel(DEFAULT_GENERATOR))

    await click(checkbox(/^Symbols/))
    await click(checkbox(/^Digits/))
    const now = { ...DEFAULT_GENERATOR, symbols: false, digits: false }
    expect(last()).toEqual(now)
    expect(preview()).toMatch(/-Ul-20$/)
    expect(strength()).toBe(strengthLabel(now))

    await type(field('Length'), '8')
    await flush()
    expect(last()?.length).toBe(8)
    expect(preview()).toMatch(/-Ul-8$/)
    expect(strength()).toBe('Weak')
    expect(document.querySelector('[data-testid="strength"]')?.textContent).toContain(
      `${Math.round(entropyBits({ ...now, length: 8 }))} bits`,
    )
  })

  it('the last character type left on cannot be turned off', async () => {
    await openGenerator()
    await click(checkbox(/^Uppercase/))
    await click(checkbox(/^Digits/))
    await click(checkbox(/^Symbols/))
    const lower = checkbox(/^Lowercase/)
    expect(lower.checked).toBe(true)
    expect(lower.disabled).toBe(true)
    expect(lower.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(lower.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'At least one character type must stay on.',
    )
    await click(checkbox(/^Digits/))
    expect(checkbox(/^Lowercase/).disabled).toBe(false)
  })

  it('options are remembered between sessions (through settings)', async () => {
    const h = await openGenerator()
    await click(checkbox(/^Avoid look-alike/))
    await click(checkbox('Use at least one of each selected type'))
    const saved = await h.api.getSettings()
    expect(saved.ok && saved.value.generator.avoidLookAlikes).toBe(true)
    expect(saved.ok && saved.value.generator.requireEachSelected).toBe(false)

    await click(button('Cancel'))
    await click(button('New entry'))
    await click(button('Generate…'))
    expect(checkbox(/^Avoid look-alike/).checked).toBe(true)
    expect(checkbox('Use at least one of each selected type').checked).toBe(false)
  })

  it('a fresh preview is visible; "Use this password" fills the (masked) field', async () => {
    await openGenerator()
    const shown = preview()
    expect(shown).toMatch(/^gen\d+-/)
    await click(button('Use this password'))
    const pw = field('Password')
    expect(pw.value).toBe(shown)
    expect(pw.type).toBe('password')
  })

  it('Generate another draws a new preview with the same options', async () => {
    const h = await openGenerator()
    const before = preview()
    const n = h.generate.calls.length
    await click(button('Generate another'))
    expect(h.generate.calls.length).toBe(n + 1)
    expect(preview()).not.toBe(before)
  })

  it('a generator error is shown and cannot be used', async () => {
    const h = await openGenerator()
    h.generate.failing = true
    await click(button('Generate another'))
    expect(document.querySelector('.generator [role="alert"]')?.textContent).toBe(
      'Could not generate a password. Please try again.',
    )
    expect(button('Use this password').disabled).toBe(true)
  })
})

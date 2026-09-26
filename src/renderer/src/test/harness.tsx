// Test harness for renderer component tests (jsdom). Uses react-dom/client and act directly.
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect } from 'vitest'
import axe from 'axe-core'
import { fail, ok } from '@shared/errors'
import type { GeneratorOptions } from '@shared/types'
import { ApiProvider, type GeneratePassword, type RendererApi } from '../api'
import { App } from '../App'
import { createMockApi, type MockControls } from '../../mocks/mockApi'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Deterministic generator for tests: records the options it was called with. */
export function scriptedGenerator(): GeneratePassword & {
  calls: GeneratorOptions[]
  failing: boolean
} {
  const calls: GeneratorOptions[] = []
  let n = 0
  const fn = ((options: GeneratorOptions) => {
    calls.push({ ...options })
    if (fn.failing)
      return fail('INVALID_ARGUMENT', 'Could not generate a password. Please try again.')
    n++
    const sets = [
      options.upper ? 'U' : '',
      options.lower ? 'l' : '',
      options.digits ? '7' : '',
      options.symbols ? '#' : '',
    ].join('')
    return ok(`gen${n}-${sets}-${options.length}`)
  }) as GeneratePassword & { calls: GeneratorOptions[]; failing: boolean }
  fn.calls = calls
  fn.failing = false
  return fn
}

export interface Harness {
  api: RendererApi
  controls: MockControls
  generate: ReturnType<typeof scriptedGenerator>
  container: HTMLElement
  unmount: () => Promise<void>
}

const mounted: Array<() => Promise<void>> = []

/** Unmounts everything rendered by `renderApp` (call from afterEach). */
export async function cleanup(): Promise<void> {
  while (mounted.length) await mounted.pop()?.()
  document.body.innerHTML = ''
}

export async function renderApp(
  init: Partial<MockControls> = {},
  wrap?: (api: RendererApi) => RendererApi,
): Promise<Harness> {
  // A desktop-sized window by default (jsdom starts at 1024 px, below the sidebar breakpoint).
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  const { api: mockApi, controls } = createMockApi({ slowUnlockTickMs: 5, ...init })
  const api = wrap ? wrap(mockApi) : mockApi
  const generate = scriptedGenerator()
  const container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  let root: Root | null = createRoot(container)
  await act(async () => {
    root?.render(
      <StrictMode>
        <ApiProvider api={api} generate={generate}>
          <App />
        </ApiProvider>
      </StrictMode>,
    )
  })
  await flush()
  const unmount = async () => {
    await act(async () => root?.unmount())
    root = null
    container.remove()
  }
  mounted.push(unmount)
  return { api, controls, generate, container, unmount }
}

/** Lets pending promises and effects settle. */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** Waits (real timers) until `check` stops throwing. */
export async function waitFor(check: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      check()
      return
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw e
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })
    }
  }
}

const isInert = (el: Element) => el.closest('[inert]') !== null

/** Text content without aria-hidden subtrees, roughly what a screen reader reads. */
function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return ''
  return Array.from(node.childNodes).map(visibleText).join('')
}

function accessibleName(el: Element): string {
  const labelled = el.getAttribute('aria-labelledby')
  if (labelled) {
    return labelled
      .split(' ')
      .map((id) => {
        const target = document.getElementById(id)
        return target ? visibleText(target) : ''
      })
      .join(' ')
      .trim()
  }
  const label = el.getAttribute('aria-label')
  if (label) return label.trim()
  return visibleText(el).replace(/\s+/g, ' ').trim()
}

/** All buttons reachable by the user (not inside an inert region). */
export function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter((b) => !isInert(b))
}

export function button(name: string | RegExp): HTMLButtonElement {
  const match = buttons().filter((b) =>
    typeof name === 'string' ? accessibleName(b) === name : name.test(accessibleName(b)),
  )
  if (match.length === 0) {
    throw new Error(
      `No button "${String(name)}". Have: ${buttons().map(accessibleName).join(' | ')}`,
    )
  }
  return match[0] as HTMLButtonElement
}

export function queryButton(name: string | RegExp): HTMLButtonElement | null {
  try {
    return button(name)
  } catch {
    return null
  }
}

export function byRole(role: string, name?: string | RegExp): HTMLElement {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[role="${role}"]`)).filter(
    (el) => !isInert(el),
  )
  const match = all.filter((el) =>
    name === undefined
      ? true
      : typeof name === 'string'
        ? accessibleName(el) === name
        : name.test(accessibleName(el)),
  )
  if (match.length === 0) throw new Error(`No role=${role} named ${String(name)}`)
  return match[match.length - 1] as HTMLElement
}

export function queryRole(role: string, name?: string | RegExp): HTMLElement | null {
  try {
    return byRole(role, name)
  } catch {
    return null
  }
}

export function dialog(name?: string | RegExp): HTMLElement {
  const all = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
  const match = all.filter((d) =>
    name === undefined
      ? true
      : typeof name === 'string'
        ? accessibleName(d) === name
        : name.test(accessibleName(d)),
  )
  if (match.length === 0) throw new Error(`No dialog ${String(name)}`)
  return match[match.length - 1] as HTMLElement
}

export function queryDialog(name?: string | RegExp): HTMLElement | null {
  try {
    return dialog(name)
  } catch {
    return null
  }
}

/** The form control labelled `text` (exact label text). */
export function field(text: string | RegExp): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll('label')).filter((l) => !isInert(l))
  const label = labels.find((l) => {
    const t = (l.textContent ?? '').replace(/\s+/g, ' ').trim()
    return typeof text === 'string' ? t === text : text.test(t)
  })
  if (!label) throw new Error(`No label "${String(text)}"`)
  const target = label.htmlFor
    ? document.getElementById(label.htmlFor)
    : label.querySelector('input, textarea, select')
  if (!target) throw new Error(`Label "${String(text)}" has no control`)
  return target as HTMLInputElement
}

export function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

export async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
  await flush()
}

/** Types into an input the way React sees it (native setter + input event). */
export async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export async function press(
  el: Element | Window,
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        metaKey: mods.meta ?? false,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
      }),
    )
  })
  await flush()
}

export async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.requestSubmit()
  })
  await flush()
}

/** Opens a recent file and unlocks it with the mock master password. */
export async function openFile(fileName = 'Personal.psafe3', password = 'demo') {
  await click(button(new RegExp(`^${fileName.replace('.', '\\.')}`)))
  await type(field('Master password'), password)
  await click(button('Unlock'))
  await flush()
}

export function option(title: string | RegExp): HTMLElement {
  return byRole('option', title instanceof RegExp ? title : new RegExp(`^${title}`))
}

/** Runs axe on the page; fails on serious or critical violations. */
export async function expectNoSeriousA11yViolations(label: string): Promise<void> {
  const result = await axe.run(document.body, {
    // jsdom has no layout, so contrast can't be computed there.
    rules: { 'color-contrast': { enabled: false } },
  })
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(
    bad.map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target).join(', ')}`),
  ).toEqual([])
}

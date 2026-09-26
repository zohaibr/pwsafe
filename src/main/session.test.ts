// docs/security-review.md F12: the spell checker must never download a dictionary.
import { describe, expect, it } from 'vitest'
import { disableSpellChecker, NO_DICTIONARY_URL, type SpellCheckSession } from './session'

function fakeSession() {
  const calls: string[] = []
  const ses: SpellCheckSession = {
    setSpellCheckerEnabled: (b) => void calls.push(`enabled:${b}`),
    setSpellCheckerLanguages: (l) => void calls.push(`languages:${JSON.stringify(l)}`),
    setSpellCheckerDictionaryDownloadURL: (u) => void calls.push(`url:${u}`),
  }
  return { ses, calls }
}

describe('disableSpellChecker', () => {
  it.each(['linux', 'win32'] as const)(
    'on %s: off, no languages, and downloads pointed at a missing local folder',
    (platform) => {
      const { ses, calls } = fakeSession()
      disableSpellChecker(ses, platform)
      expect(calls).toEqual(['enabled:false', `url:${NO_DICTIONARY_URL}`, 'languages:[]'])
    },
  )

  it('on macOS: off (the OS spell checker never downloads; languages are a no-op there)', () => {
    const { ses, calls } = fakeSession()
    disableSpellChecker(ses, 'darwin')
    expect(calls).toEqual(['enabled:false', `url:${NO_DICTIONARY_URL}`])
  })

  it('the download URL is local and cannot reach the network', () => {
    const u = new URL(NO_DICTIONARY_URL)
    expect(u.protocol).toBe('file:')
    expect(u.host).toBe('')
    expect(u.pathname.endsWith('/')).toBe(true)
  })
})

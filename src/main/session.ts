// Session-level hardening that does not depend on the window (docs/security-review.md F12).
// No Electron import, so it can be unit-tested with a fake session.

/** The spell-checker controls of Electron's Session. */
export interface SpellCheckSession {
  setSpellCheckerEnabled(enable: boolean): void
  setSpellCheckerLanguages(languages: string[]): void
  setSpellCheckerDictionaryDownloadURL(url: string): void
}

/**
 * Where Chromium would fetch hunspell dictionaries from instead of its CDN: a file URL to a folder
 * that does not exist, so a download attempt fails locally without touching the network.
 */
export const NO_DICTIONARY_URL = 'file:///nonexistent-psafe3-opener-dictionaries/'

/**
 * Turns the built-in spell checker off for a session. `webPreferences.spellcheck: false` only
 * stops checking in the page; the session still downloads a hunspell dictionary for the UI
 * language from Google's CDN (Linux and Windows), which would break "no network requests".
 * With no languages and the download pointed at a missing local folder, nothing is fetched.
 * macOS uses the OS spell checker and never downloads (Electron makes the last two calls no-ops).
 */
export function disableSpellChecker(ses: SpellCheckSession, platform: NodeJS.Platform): void {
  ses.setSpellCheckerEnabled(false)
  ses.setSpellCheckerDictionaryDownloadURL(NO_DICTIONARY_URL)
  if (platform !== 'darwin') ses.setSpellCheckerLanguages([])
}

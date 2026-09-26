// XML escaping for the Password Safe XML export (docs/execution-plan.md §A7).
// Written in-house so the export needs no dependency.

/**
 * Characters XML 1.0 allows at all (production [2] Char): tab, LF, CR, U+0020-U+D7FF,
 * U+E000-U+FFFD and U+10000-U+10FFFF. Anything else (other C0 controls, lone surrogates,
 * U+FFFE, U+FFFF) cannot appear in an XML document, not even inside CDATA or as a reference.
 */
const INVALID_XML_CHAR = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u

/** True when every character of `text` may appear in an XML 1.0 document. */
export function isXmlSafe(text: string): boolean {
  return !INVALID_XML_CHAR.test(text)
}

/**
 * Escapes text for use inside a double-quoted attribute value. Tab, LF and CR become character
 * references so attribute-value normalisation does not turn them into spaces.
 * The caller must check isXmlSafe first.
 */
export function escapeAttribute(text: string): string {
  return text.replace(/[&<>"'\t\n\r]/g, (c) => ATTR_ESCAPES[c] as string)
}

const ATTR_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
}

/**
 * Element content for `text` written as CDATA, the way Password Safe writes its own export.
 *
 * - Each `]]>` is split across two CDATA sections, `...]]` and `>...`, so the section never
 *   ends early (`a]]>b` becomes `<![CDATA[a]]]]><![CDATA[>b]]>`).
 * - A CR cannot survive inside CDATA (XML parsers turn CR and CRLF into LF), so each CR is
 *   written between sections as the reference `&#13;`.
 *
 * The caller must check isXmlSafe first.
 */
export function cdataContent(text: string): string {
  return text
    .split('\r')
    .map((part) => `<![CDATA[${part.split(']]>').join(']]]]><![CDATA[>')}]]>`)
    .join('&#13;')
}

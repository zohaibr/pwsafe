// Test-only reader for Password Safe XML: enough to pull entry values back out of our export and
// out of pwsafe-cli's export, decoding CDATA sections and character/entity references exactly.
// Not used by the app.

export interface ParsedExport {
  attributes: Record<string, string>
  entries: Record<string, string>[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeRefs(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16))
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10))
    const e = ENTITIES[ref]
    if (e === undefined) throw new Error(`unknown entity ${m}`)
    return e
  })
}

export function parseExport(xml: string): ParsedExport {
  const rootStart = xml.indexOf('<passwordsafe')
  if (rootStart < 0) throw new Error('no <passwordsafe> element')
  const rootEnd = xml.indexOf('>', rootStart)
  const attributes: Record<string, string> = {}
  for (const m of xml.slice(rootStart, rootEnd).matchAll(/([\w:]+)="([^"]*)"/g)) {
    attributes[m[1]!] = decodeRefs(m[2]!)
  }

  const entries: Record<string, string>[] = []
  let pos = rootEnd + 1
  for (;;) {
    const start = xml.indexOf('<entry', pos)
    if (start < 0) break
    pos = xml.indexOf('>', start) + 1
    const entry: Record<string, string> = {}
    for (;;) {
      while (/\s/.test(xml[pos] ?? '')) pos++
      if (xml.startsWith('</entry>', pos)) {
        pos += '</entry>'.length
        break
      }
      if (xml.startsWith('<!--', pos)) {
        pos = xml.indexOf('-->', pos) + 3
        continue
      }
      const open = /^<([\w]+)>/.exec(xml.slice(pos, pos + 64))
      if (open === null) throw new Error(`unexpected content at ${pos}`)
      const name = open[1]!
      pos += open[0].length
      const close = `</${name}>`
      let value = ''
      let nested = false
      for (;;) {
        if (xml.startsWith(close, pos)) {
          pos += close.length
          break
        }
        if (xml.startsWith('<![CDATA[', pos)) {
          const end = xml.indexOf(']]>', pos + 9)
          value += xml.slice(pos + 9, end).replace(/\r\n?/g, '\n')
          pos = end + 3
          continue
        }
        if (xml[pos] === '<') {
          // A nested element (e.g. pwhistory): skip to this element's closing tag.
          nested = true
          pos = xml.indexOf(close, pos)
          continue
        }
        const next = xml.slice(pos).search(/<|$/)
        // Character data outside CDATA: line ends are normalised to LF by XML parsers.
        value += decodeRefs(xml.slice(pos, pos + next).replace(/\r\n?/g, '\n'))
        pos += next
      }
      if (!nested) entry[name] = value
    }
    entries.push(entry)
  }
  return { attributes, entries }
}

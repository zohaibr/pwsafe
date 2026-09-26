// Fake sample data for the mock API. Every value here is made up for demos and tests; none of
// these are real accounts or real passwords.
import type { BackupInfo, Entry, EntryFlags } from '@shared/types'

/** Master password that unlocks every mock file. Anything else is WRONG_PASSWORD. */
export const MOCK_MASTER_PASSWORD = 'demo'

const noFlags: EntryFlags = {
  hasHistory: false,
  hasTotp: false,
  hasAttachment: false,
  hasPasskey: false,
  hasCreditCard: false,
  hasCustomFields: false,
  extraFieldCount: 0,
}

interface Sample extends Omit<Entry, 'flags' | 'kind' | 'editable' | 'email' | 'notes' | 'url'> {
  flags?: Partial<EntryFlags>
  kind?: Entry['kind']
  editable?: boolean
  email?: string
  notes?: string
  url?: string
}

function entry(s: Sample): Entry {
  return {
    email: '',
    notes: '',
    url: '',
    kind: 'normal',
    editable: true,
    ...s,
    flags: { ...noFlags, ...s.flags },
  }
}

const created = '2024-03-11T09:14:00.000Z'
const modified = '2026-08-02T17:40:00.000Z'

/** Sample entries with passwords filled in. The mock blanks passwords before handing out lists. */
export function sampleEntries(): Entry[] {
  return [
    entry({
      uuid: '5f2c1a6e-0001-4d1a-9a55-000000000001',
      title: 'Example Bank',
      group: 'Personal.Banking',
      username: 'sam.demo',
      password: 'demo-Kq7!vR2p-sample',
      url: 'https://bank.example.com',
      notes: 'Customer number is on the back of the demo card.',
      created,
      modified,
      passwordModified: '2026-01-20T08:00:00.000Z',
      flags: { hasHistory: true, hasTotp: true, extraFieldCount: 3 },
    }),
    entry({
      uuid: '5f2c1a6e-0002-4d1a-9a55-000000000002',
      title: 'Credit Union',
      group: 'Personal.Banking',
      username: 'sam.demo@example.org',
      password: 'demo-cu-4481-sample',
      url: 'https://cu.example.net',
      created,
      modified,
      flags: { hasCreditCard: true, extraFieldCount: 2 },
    }),
    entry({
      uuid: '5f2c1a6e-0003-4d1a-9a55-000000000003',
      title: 'Mail',
      group: 'Personal',
      username: 'sam.demo',
      password: 'demo-mail-Tz9#-sample',
      url: 'https://mail.example.org',
      email: 'sam.demo@example.org',
      created,
      modified,
      kind: 'shortcutBase',
    }),
    entry({
      uuid: '5f2c1a6e-0004-4d1a-9a55-000000000004',
      title: 'Bookshop',
      group: 'Personal.Shopping',
      username: 'sam.reads',
      password: 'demo-books-88-sample',
      url: 'https://books.example.com',
      created,
      modified,
      expires: '2026-12-31T00:00:00.000Z',
    }),
    entry({
      uuid: '5f2c1a6e-0005-4d1a-9a55-000000000005',
      title: 'Grocery delivery',
      group: 'Personal.Shopping',
      username: 'sam.demo',
      password: 'demo-groc-Pw3-sample',
      url: 'https://groceries.example.com',
      created,
      modified,
      kind: 'aliasBase',
    }),
    entry({
      uuid: '5f2c1a6e-0006-4d1a-9a55-000000000006',
      title: 'Grocery app',
      group: 'Personal.Shopping',
      username: 'sam.demo',
      password: 'demo-groc-Pw3-sample',
      created,
      modified,
      kind: 'alias',
      baseUuid: '5f2c1a6e-0005-4d1a-9a55-000000000005',
      editable: false,
      readOnlyReason: 'Alias of another entry. Aliases are read-only in this version.',
    }),
    entry({
      uuid: '5f2c1a6e-0007-4d1a-9a55-000000000007',
      title: 'Company VPN',
      group: 'Work',
      username: 'sdemo',
      password: 'demo-vpn-L0ng-sample',
      url: 'https://vpn.corp.example',
      created,
      modified,
      flags: { hasPasskey: true, extraFieldCount: 6 },
    }),
    entry({
      uuid: '5f2c1a6e-0008-4d1a-9a55-000000000008',
      title: 'build-server-01',
      group: 'Work.Servers',
      username: 'deploy',
      password: 'demo-ssh-9f8e-sample',
      notes: 'Host: build01.corp.example\nPort: 2222\nKey fingerprint is in the attached file.',
      created,
      modified,
      flags: { hasAttachment: true, extraFieldCount: 5 },
    }),
    entry({
      uuid: '5f2c1a6e-0009-4d1a-9a55-000000000009',
      title: 'Database admin',
      group: 'Work.Servers',
      username: 'dba',
      password: 'demo-db-Adm1n-sample',
      created,
      modified,
      editable: false,
      readOnlyReason: 'Protected in Password Safe. Unprotect it there to edit it.',
      flags: { extraFieldCount: 1 },
    }),
    entry({
      uuid: '5f2c1a6e-0010-4d1a-9a55-000000000010',
      title: 'Legacy intranet',
      group: 'Work\\.old',
      username: 'sdemo',
      password: 'demo-intranet-sample',
      url: 'http://intranet.old.example',
      created,
      modified,
      editable: false,
      readOnlyReason:
        'This entry has two Title fields. It is read-only so no data is lost when saving.',
    }),
    entry({
      uuid: '5f2c1a6e-0011-4d1a-9a55-000000000011',
      title: 'Home Wi-Fi',
      group: 'Family',
      username: '',
      password: 'demo-wifi-guest-sample',
      notes: 'Network: DEMO-HOME\nGuest network: DEMO-GUEST',
      created,
      modified,
    }),
    entry({
      uuid: '5f2c1a6e-0012-4d1a-9a55-000000000012',
      title: 'Family mail',
      group: 'Family',
      username: 'sam.demo',
      password: 'demo-mail-Tz9#-sample',
      created,
      modified,
      kind: 'shortcut',
      baseUuid: '5f2c1a6e-0003-4d1a-9a55-000000000003',
      editable: false,
      readOnlyReason: 'Shortcut to another entry. Shortcuts are read-only in this version.',
    }),
    entry({
      uuid: '5f2c1a6e-0013-4d1a-9a55-000000000013',
      title: 'Router admin',
      group: 'Family',
      username: 'admin',
      password: 'demo-router-7x-sample',
      url: 'http://192.0.2.1',
      created,
      modified,
      flags: { hasCustomFields: true, extraFieldCount: 2 },
    }),
    entry({
      uuid: '5f2c1a6e-0014-4d1a-9a55-000000000014',
      title: 'Café loyalty ☕',
      group: 'Personal.Shopping',
      username: 'sam.démo',
      password: 'demo-café-2026-sample',
      created,
      modified,
    }),
  ]
}

export function sampleBackups(): BackupInfo[] {
  return [
    { id: 'bak-1', generation: 1, modifiedAt: '2026-09-25T18:02:00.000Z', sizeBytes: 12_688 },
    { id: 'bak-2', generation: 2, modifiedAt: '2026-09-20T09:41:00.000Z', sizeBytes: 12_432 },
    { id: 'bak-3', generation: 3, modifiedAt: '2026-09-02T21:15:00.000Z', sizeBytes: 11_920 },
  ]
}

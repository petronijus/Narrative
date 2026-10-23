import type os from 'node:os'
import { describe, expect, it } from 'vitest'
import { DisturbanceLog } from '../disturbance.js'
import { diffInterfaces, snapshotInterfaces, watchNetwork } from './networkWatch.js'

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>

function iface(...addresses: string[]): os.NetworkInterfaceInfo[] {
  return addresses.map(
    (address) =>
      ({
        address,
        netmask: '255.255.255.0',
        family: address.includes(':') ? 'IPv6' : 'IPv4',
        mac: '02:00:00:00:00:00',
        internal: false,
        cidr: null,
      }) as os.NetworkInterfaceInfo,
  )
}

const BASE: Ifaces = {
  lo0: iface('127.0.0.1', '::1'),
  en0: iface('192.168.88.197'),
  awdl0: iface('fe80::68de'),
}

describe('snapshotInterfaces', () => {
  it('maps interfaces to their sorted addresses, without AWDL / LLW churn', () => {
    expect(
      snapshotInterfaces(() => ({
        ...BASE,
        llw0: iface('fe80::1'),
        en14: iface('fe80::c2f', '172.16.42.2'),
      })),
    ).toEqual({
      lo0: ['127.0.0.1', '::1'],
      en0: ['192.168.88.197'],
      en14: ['172.16.42.2', 'fe80::c2f'],
    })
  })
})

describe('diffInterfaces', () => {
  it('names an interface that came, went or changed its addresses', () => {
    expect(diffInterfaces({ en0: ['a'] }, { en0: ['a'] })).toEqual([])
    expect(
      diffInterfaces(
        { en0: ['192.168.88.197'], en14: ['172.16.42.2'] },
        { en0: ['192.168.88.198', 'fe80::1'], utun4: ['100.110.110.10'] },
      ),
    ).toEqual([
      'en0 addresses −192.168.88.197 +192.168.88.198, +fe80::1',
      'en14 gone (172.16.42.2)',
      'utun4 up (100.110.110.10)',
    ])
  })
})

describe('watchNetwork', () => {
  it('records a host disturbance per change it polls, nothing while it stays the same', () => {
    let current: Ifaces = { ...BASE, en14: iface('172.16.42.2') }
    let t = 5000
    const log = new DisturbanceLog(() => t)
    // A long interval: the test polls by hand with flush().
    const watch = watchNetwork(log, { read: () => current, intervalMs: 3_600_000, now: () => t })
    try {
      watch.flush()
      expect(log.all()).toEqual([])
      // The phone re-attaches: en14 goes, then comes back.
      current = { ...BASE }
      t = 6000
      watch.flush()
      current = { ...BASE, en14: iface('172.16.42.2') }
      t = 6400
      watch.flush()
      // AirDrop's link changing is no change of the network.
      current = { ...current, awdl0: iface('fe80::99') }
      watch.flush()
      expect(log.all()).toEqual([
        { at: 6000, source: 'host', detail: 'en14 gone (172.16.42.2)' },
        { at: 6400, source: 'host', detail: 'en14 up (172.16.42.2)' },
      ])
    } finally {
      watch.stop()
    }
  })
})

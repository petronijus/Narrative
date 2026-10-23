/**
 * networkWatch.ts — the host side of disturbance detection (disturbance.ts):
 * a poll of the machine's network interfaces that records every change in a
 * `DisturbanceLog`.
 *
 * Chrome aborts its requests with `net::ERR_NETWORK_CHANGED` when the OS
 * reports an IP address change: on macOS a `State:/Network/Global/IPv4|IPv6`
 * change in configd, on Linux a netlink address or link event. Both follow
 * an interface appearing, going down or changing its addresses — which
 * `os.networkInterfaces()` (getifaddrs; libuv lists only interfaces that are
 * up and running) shows without root, without a subprocess and on every OS.
 * A call costs ~50 µs (MacBook, 2026-10-23), so a 100 ms poll is noise even
 * next to a measured frame. A change shorter than a poll can slip through;
 * the browser side (a request failing with ERR_NETWORK_CHANGED) still sees
 * what it did to the page.
 *
 * Considered and not used: `route -n monitor` prints every routing-socket
 * message (194 RTM_MISS lookups in 95 s on the MacBook, nothing to do with a
 * change) and `scutil`'s `n.watch` could not be shown to stream to a pipe;
 * `ip monitor` exists on Linux only.
 */

import os from 'node:os'
import type { DisturbanceLog } from '../disturbance.js'

/** Interface name → its addresses, sorted. */
export type InterfaceSnapshot = Readonly<Record<string, readonly string[]>>

/**
 * Interfaces whose churn is not a change of the machine's network: macOS's
 * Apple Wireless Direct Link (AirDrop, Continuity) and its low-latency WLAN
 * twin come and go on their own and never touch configd's global state.
 */
export const IGNORED_INTERFACES = /^(awdl|llw)\d+$/

export function snapshotInterfaces(
  read: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces,
  ignore: RegExp = IGNORED_INTERFACES,
): InterfaceSnapshot {
  const out: Record<string, string[]> = {}
  for (const [name, infos] of Object.entries(read())) {
    if (infos === undefined || ignore.test(name)) continue
    out[name] = [...new Set(infos.map((i) => i.address))].sort()
  }
  return out
}

/** What changed between two snapshots, one line per interface: `en14 gone (172.16.42.2)`. */
export function diffInterfaces(before: InterfaceSnapshot, after: InterfaceSnapshot): string[] {
  const lines: string[] = []
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  for (const name of names) {
    const a = before[name]
    const b = after[name]
    if (a === undefined) lines.push(`${name} up (${b!.join(', ')})`)
    else if (b === undefined) lines.push(`${name} gone (${a.join(', ')})`)
    else {
      const added = b.filter((x) => !a.includes(x))
      const removed = a.filter((x) => !b.includes(x))
      if (added.length > 0 || removed.length > 0)
        lines.push(
          `${name} addresses${removed.length > 0 ? ` −${removed.join(', −')}` : ''}${
            added.length > 0 ? ` +${added.join(', +')}` : ''
          }`,
        )
    }
  }
  return lines
}

export interface NetworkWatch {
  /** Poll now (before asking the log about a window that just ended). */
  flush(): void
  stop(): void
}

export interface NetworkWatchOptions {
  intervalMs?: number
  read?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
  ignore?: RegExp
  now?: () => number
}

/** Poll the interfaces every `intervalMs` (100) and record each change as a `host` disturbance. */
export function watchNetwork(log: DisturbanceLog, options: NetworkWatchOptions = {}): NetworkWatch {
  const read = options.read ?? os.networkInterfaces
  const ignore = options.ignore ?? IGNORED_INTERFACES
  const now = options.now ?? Date.now
  let last = snapshotInterfaces(read, ignore)
  const poll = (): void => {
    let next: InterfaceSnapshot
    try {
      next = snapshotInterfaces(read, ignore)
    } catch {
      return // getifaddrs failing is no change of the network
    }
    const changes = diffInterfaces(last, next)
    last = next
    if (changes.length > 0) log.record('host', changes.join('; '), now())
  }
  const timer = setInterval(poll, options.intervalMs ?? 100)
  // Never what keeps a test worker or the perf run alive.
  timer.unref?.()
  return {
    flush: poll,
    stop: () => clearInterval(timer),
  }
}

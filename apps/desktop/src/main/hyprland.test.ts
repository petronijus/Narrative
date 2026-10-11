import { describe, expect, it } from 'vitest'
import {
  findWindow,
  isHyprland,
  logicalSize,
  matchMonitor,
  moveWindowCommands,
  type HyprMonitor,
} from './hyprland.js'

const monitor = (name: string, over: Partial<HyprMonitor> = {}): HyprMonitor => ({
  name,
  x: 0,
  y: 0,
  width: 3840,
  height: 2160,
  scale: 1,
  transform: 0,
  activeWorkspace: { id: 1, name: '1' },
  ...over,
})

describe('Hyprland placement', () => {
  it('measures monitors in logical pixels, rotation included', () => {
    expect(logicalSize(monitor('a', { scale: 1.5 }))).toEqual({ width: 2560, height: 1440 })
    expect(logicalSize(monitor('a', { transform: 1 }))).toEqual({ width: 2160, height: 3840 })
    expect(logicalSize(monitor('a', { transform: 7, scale: 2 }))).toEqual({
      width: 1080,
      height: 1920,
    })
  })

  it('finds the monitor the page chose', () => {
    const ultrawide = monitor('DP-4', { width: 7680 })
    const projector = monitor('HDMI-A-1', {
      x: 7680,
      width: 1920,
      height: 1080,
      activeWorkspace: { id: 6, name: '6' },
    })
    expect(
      matchMonitor({ left: 7680, top: 0, width: 1920, height: 1080 }, [ultrawide, projector]),
    ).toBe(projector)
    expect(
      matchMonitor({ left: 7681, top: 0, width: 1919, height: 1080 }, [ultrawide, projector]),
    ).toBe(projector)
    expect(
      matchMonitor({ left: 100, top: 0, width: 1920, height: 1080 }, [ultrawide, projector]),
    ).toBeNull()
  })

  it('finds its own window by process and title', () => {
    const clients = [
      { address: '0x1', pid: 10, title: 'Narrative', mapped: true },
      { address: '0x2', pid: 20, title: 'Narrative', mapped: true },
      { address: '0x3', pid: 20, title: 'Presenter', mapped: true },
    ]
    expect(findWindow(clients, 20, 'Narrative')?.address).toBe('0x2')
    expect(findWindow(clients, 30, 'Narrative')).toBeNull()
  })

  it('builds both dispatcher forms, and nothing from a malformed address', () => {
    expect(moveWindowCommands('0xabc', 6)).toEqual([
      [
        'dispatch',
        'hl.dsp.window.move({ window = "address:0xabc", workspace = "6", follow = false })',
      ],
      ['dispatch', 'movetoworkspacesilent', '6,address:0xabc'],
    ])
    expect(moveWindowCommands('0xabc"); os.execute("x', 6)).toEqual([])
  })

  it('knows when it runs under Hyprland on Wayland', () => {
    expect(isHyprland({ HYPRLAND_INSTANCE_SIGNATURE: 'x', XDG_SESSION_TYPE: 'wayland' })).toBe(true)
    expect(isHyprland({ XDG_SESSION_TYPE: 'wayland' })).toBe(false)
  })
})

/**
 * ui/AvatarChips.tsx
 *
 * M8: Avatar chips pro connected peery v toolbar pravé části.
 *
 * Render:
 * - Kruh 26px s iniciálami (první 2 znaky z name) a background = peer.color.
 * - Hover tooltip: full name + "(you)" pro lokálního peera.
 * - Max 5 viditelných chipů, potom "+N" chip s rozbalovacím popoverem.
 * - Layout: horizontal stack, gap 4px, pravá strana toolbaru.
 *
 * Accessibility:
 * - role="list" + role="listitem" pro screen readers.
 * - aria-label na každém chipu s jménem peera.
 * - Popover je button s aria-expanded.
 *
 * Pointer-events: auto — chipy jsou interaktivní.
 *
 * Agentic A1: the peer the server publishes for an agent run ("Claude
 * (MCP)") renders as a rounded square with a bot glyph instead of a round
 * initials chip, and its tooltip says whom it works for.
 */

import { useState } from 'react'
import { Bot } from 'lucide-react'
import { usePresencePeers } from '../state/useAwareness.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { PeerInfo } from '@narrative/shared'
import { agentPeerLabel, isAgentPeer } from './peerPresence.js'
import { useLocalAgentPrincipalKey } from './useLocalAgentPrincipalKey.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 5
const CHIP_SIZE = 26 // px

// ---------------------------------------------------------------------------
// Single chip
// ---------------------------------------------------------------------------

interface AvatarChipProps {
  peer: PeerInfo
  isLocal: boolean
  /** The local user's agent principal key, to say "working for you" (peerPresence.ts). */
  localPrincipalKey: string | null
}

function getInitials(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  // Vezmi první 2 znaky (funguje i bez space)
  const parts = trimmed.split(/\s+/)
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
  }
  return trimmed.slice(0, 2).toUpperCase()
}

function peerLabel(peer: PeerInfo, isLocal: boolean, localPrincipalKey: string | null): string {
  if (isAgentPeer(peer)) return agentPeerLabel(peer, localPrincipalKey)
  return isLocal ? `${peer.state.user.name} (you)` : peer.state.user.name
}

function AgentChip({ peer, label }: { peer: PeerInfo; label: string }) {
  return (
    <li
      role="listitem"
      className="relative flex-shrink-0"
      data-agent-peer={peer.state.agent?.runId}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-label={label}
            tabIndex={0}
            className="flex cursor-default items-center justify-center rounded-md text-white ring-1 ring-white/40 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            style={{
              width: CHIP_SIZE,
              height: CHIP_SIZE,
              backgroundColor: peer.state.user.color,
            }}
          >
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </li>
  )
}

function AvatarChip({ peer, isLocal, localPrincipalKey }: AvatarChipProps) {
  const label = peerLabel(peer, isLocal, localPrincipalKey)
  if (isAgentPeer(peer)) return <AgentChip peer={peer} label={label} />
  const initials = getInitials(peer.state.user.name)

  return (
    <li role="listitem" className="relative flex-shrink-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-label={label}
            tabIndex={0}
            className="flex items-center justify-center rounded-full text-white font-semibold select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            style={{
              width: CHIP_SIZE,
              height: CHIP_SIZE,
              backgroundColor: peer.state.user.color,
              fontSize: 10,
              letterSpacing: '0.02em',
              boxShadow: isLocal
                ? `0 0 0 2px white, 0 0 0 3px ${peer.state.user.color}`
                : undefined,
              cursor: 'default',
            }}
          >
            {initials}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Overflow popover
// ---------------------------------------------------------------------------

interface OverflowPopoverProps {
  hiddenPeers: PeerInfo[]
  localClientId: number
  localPrincipalKey: string | null
}

function OverflowPopover({ hiddenPeers, localClientId, localPrincipalKey }: OverflowPopoverProps) {
  const [open, setOpen] = useState(false)
  const count = hiddenPeers.length

  return (
    <li role="listitem" className="relative flex-shrink-0">
      <button
        type="button"
        aria-label={`${count} more collaborators`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center justify-center rounded-full bg-gray-700 text-gray-300 font-semibold text-xs hover:bg-gray-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        style={{ width: CHIP_SIZE, height: CHIP_SIZE, fontSize: 10 }}
      >
        +{count}
      </button>

      {open && (
        <>
          {/* Backdrop — zavřít kliknutím mimo */}
          <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
          {/* Popover list */}
          <ul
            role="listbox"
            aria-label="All collaborators"
            className="absolute right-0 top-full z-50 mt-1 min-w-max rounded-md border border-gray-700 bg-gray-900 py-1 shadow-xl"
          >
            {hiddenPeers.map((peer) => {
              const isLocal = peer.clientId === localClientId
              const label = peerLabel(peer, isLocal, localPrincipalKey)
              const agent = isAgentPeer(peer)
              return (
                <li
                  key={peer.clientId}
                  role="option"
                  aria-selected={false}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300"
                >
                  <span
                    aria-hidden="true"
                    className={
                      'flex h-5 w-5 flex-shrink-0 items-center justify-center text-white font-semibold ' +
                      (agent ? 'rounded-sm' : 'rounded-full')
                    }
                    style={{ backgroundColor: peer.state.user.color, fontSize: 9 }}
                  >
                    {agent ? <Bot className="h-3 w-3" /> : getInitials(peer.state.user.name)}
                  </span>
                  {label}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Horizontal stack chipů pro všechny connected peery.
 * Vložit do pravé části Toolbar.tsx.
 */
export function AvatarChips() {
  // Identities only: this client's cursor moving does not re-render the chips.
  const { peers, localClientId } = usePresencePeers()
  const localPrincipalKey = useLocalAgentPrincipalKey()

  if (peers.length === 0) return null

  const visiblePeers = peers.slice(0, MAX_VISIBLE)
  const hiddenPeers = peers.slice(MAX_VISIBLE)

  return (
    <ul role="list" aria-label="Connected collaborators" className="flex items-center gap-1">
      {visiblePeers.map((peer) => (
        <AvatarChip
          key={peer.clientId}
          peer={peer}
          isLocal={peer.clientId === localClientId}
          localPrincipalKey={localPrincipalKey}
        />
      ))}

      {hiddenPeers.length > 0 && (
        <OverflowPopover
          hiddenPeers={hiddenPeers}
          localClientId={localClientId}
          localPrincipalKey={localPrincipalKey}
        />
      )}
    </ul>
  )
}

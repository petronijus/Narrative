/**
 * commands/src/parity/allowlist.ts
 *
 * The ONLY place a user-facing capability may be deliberately left out of
 * the agent surface. Each entry needs a real reason; adding one is a
 * reviewed change (the agent-parity agent checks every new entry).
 */

import type { RouteRef } from '../types.js'

export interface AllowlistEntry {
  capability: string
  reason: string
  /**
   * API routes this exclusion covers (method + path exactly as Fastify
   * registers them). The server's route guard treats them as deliberately
   * outside the agent surface.
   */
  routes?: readonly RouteRef[]
}

export const AGENT_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    capability: 'Zoom and pan',
    reason: 'Per-tab view state of one editor window; nothing in the document changes.',
  },
  {
    capability: 'Stage background colour',
    reason: 'Per-tab editor preference, not document content.',
  },
  { capability: 'Rulers on/off', reason: 'Per-browser editor preference stored in localStorage.' },
  {
    capability: 'Active tool',
    reason: 'Transient pointer mode of one editor; agents create objects directly.',
  },
  {
    capability: 'Selection',
    reason:
      'Per-user editor state; agents address objects by id and read the user selection via editor.context.',
  },
  {
    capability: 'Group isolation (entered group)',
    reason: 'Transient editor navigation state with no document effect.',
  },
  {
    capability: 'Shortcut cheatsheet',
    reason: 'Help overlay for humans; agents read tool descriptions instead.',
  },
  { capability: 'FPS overlay', reason: 'Developer diagnostics overlay with no document effect.' },
  {
    capability: 'Present-mode navigation, fullscreen, presenter window',
    reason:
      'Human presentation runtime, not document state; agents get editor.present.link to open a deck at a slide.',
  },
  {
    capability: 'Browser sign-in and session (Google OAuth start/callback, current user, sign-out)',
    reason:
      'The interactive browser login that mints the session cookie. Agents never sign in this way: they authenticate ' +
      'with a personal access token (or MCP OAuth) and every MCP session is already bound to one user.',
    routes: [
      { method: 'GET', path: '/auth/start' },
      { method: 'GET', path: '/auth/callback' },
      { method: 'GET', path: '/auth/me' },
      { method: 'POST', path: '/auth/logout' },
    ],
  },
  {
    capability: 'Health check',
    reason:
      'Liveness probe for the Docker healthcheck and the reverse proxy; it reports no document or user state.',
    routes: [{ method: 'GET', path: '/health' }],
  },
  {
    capability: 'Prometheus metrics',
    reason:
      'Operations telemetry (connection counts, document sizes) scraped by Prometheus with METRICS_TOKEN; not a user ' +
      'capability and deliberately kept away from user credentials.',
    routes: [{ method: 'GET', path: '/metrics' }],
  },
]

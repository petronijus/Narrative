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
    capability: 'Snapping on/off (toolbar toggle, Mod held while dragging)',
    reason:
      'Per-browser editor preference for pointer drags. Agents set exact coordinates and align with ' +
      'object.align / object.alignToSlide and the deck guides from query.deck.',
  },
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
    capability: 'Render tokens for the e2e suite (development only)',
    reason:
      'POST /dev/render-token exists only with BYPASS_AUTH (refused in production) so the e2e suite can open the ' +
      'render page as the render worker does. Render tokens are credentials only the server mints for its own ' +
      'render jobs; an agent asks for a render (query.render, A3) and never holds one.',
    routes: [{ method: 'POST', path: '/dev/render-token' }],
  },
  {
    capability: 'Personal access tokens (list, create, revoke)',
    reason:
      'Credential management. An agent must not mint or revoke credentials: a leaked agent token that could create ' +
      'tokens would outlive its own revocation. The routes accept only the browser session cookie and reject any ' +
      'personal access token (apps/server/src/routes/accessTokens.ts).',
    routes: [
      { method: 'GET', path: '/access-tokens' },
      { method: 'POST', path: '/access-tokens' },
      { method: 'DELETE', path: '/access-tokens/:id' },
    ],
  },
  {
    capability: 'Command API transport (POST /commands, public /api/commands)',
    reason:
      'Not a capability of its own: the HTTP transport that runs registered commands for scripts, exactly as the ' +
      'MCP server does for Claude clients. Everything it can do is a command in this registry, authorised and ' +
      'logged by the server host.',
    routes: [{ method: 'POST', path: '/commands' }],
  },
  {
    capability: 'MCP transport (GET/POST/DELETE /mcp, public /api/mcp)',
    reason:
      'Not a capability of its own: the Streamable HTTP transport that serves this registry to Claude clients. Every ' +
      'tool is generated from a registered command and runs through the server host, which authorises, confirms ' +
      'irreversible commands and logs each op (apps/server/src/mcp/).',
    routes: [
      { method: 'GET', path: '/mcp' },
      { method: 'POST', path: '/mcp' },
      { method: 'DELETE', path: '/mcp' },
    ],
  },
  {
    capability:
      'MCP OAuth authorization server (metadata, client registration, authorize, consent, token, revoke)',
    reason:
      'Protocol plumbing, not a user capability: how claude.ai connectors obtain a token for /mcp (RFC 9728, 8414, ' +
      '7591, 7636, 7009), with the Google sign-in session as the login step. An agent never signs in this way; it ' +
      'is what gives the agent its session in the first place.',
    routes: [
      { method: 'GET', path: '/.well-known/oauth-protected-resource' },
      { method: 'GET', path: '/.well-known/oauth-protected-resource/*' },
      { method: 'GET', path: '/.well-known/oauth-authorization-server' },
      { method: 'GET', path: '/.well-known/oauth-authorization-server/*' },
      { method: 'POST', path: '/oauth/register' },
      { method: 'GET', path: '/oauth/authorize' },
      { method: 'GET', path: '/oauth/authorize/consent' },
      { method: 'POST', path: '/oauth/authorize/decision' },
      { method: 'POST', path: '/oauth/token' },
      { method: 'POST', path: '/oauth/revoke' },
    ],
  },
  {
    capability: 'Connected MCP apps (list, disconnect)',
    reason:
      'Credential management, like personal access tokens: an agent must not see or revoke the grants that give ' +
      'agents access. Session-cookie only (authPreHandler rejects every token).',
    routes: [
      { method: 'GET', path: '/oauth/connections' },
      { method: 'DELETE', path: '/oauth/connections/:id' },
    ],
  },
  {
    capability: 'Approving or declining an agent request (the confirmation page)',
    reason:
      'The human side of the human in the loop: a signed-in person approves or declines an agent call that needs ' +
      'their confirmation (irreversible commands, URL downloads). An agent must never be able to approve its own ' +
      "request, so the routes accept only the browser session cookie from Narrative's own origin and reject every " +
      'token (apps/server/src/routes/agentConfirmations.ts).',
    routes: [
      { method: 'GET', path: '/agent-confirmations/:id' },
      { method: 'POST', path: '/agent-confirmations/:id/decision' },
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
  {
    capability: 'Speaker-notes live editing (Tiptap + y-prosemirror binding)',
    reason:
      "Not a separate capability: a CRDT editor binding that writes the slide's notes Y.XmlFragment keystroke by " +
      'keystroke, which no command could replay usefully. Agents read and replace the same fragment with ' +
      'slide.notes.get / slide.notes.set; the binding is the one editor write the one-door lint cannot see, so it ' +
      'is recorded here.',
  },
]

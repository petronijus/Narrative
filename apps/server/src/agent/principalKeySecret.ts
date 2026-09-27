/**
 * agent/principalKeySecret.ts
 *
 * The secret the agent principal keys are MACed with (agent/presence.ts,
 * `createAgentPrincipalKeys`): env `AGENT_PRINCIPAL_KEY_SECRET`.
 *
 *   production  required, at least 32 characters (generate one with
 *               `openssl rand -base64 48`); the server refuses to start
 *               without it, because a guessable key would let anyone who
 *               knows a user's Google sub tell which agent peer works for
 *               them.
 *   dev / test  optional; falls back to DEV_AGENT_PRINCIPAL_KEY_SECRET.
 *
 * Rotating it changes every key: an editor already open keeps the key it
 * was told at connect time until it reconnects, so for a moment its own
 * agent is labelled by display name instead of "you". Nothing is stored
 * under the key, so a rotation needs no migration.
 */

import { AGENT_PRINCIPAL_KEY_SECRET_MIN_LENGTH } from './presence.js'

/** Dev/test-only fallback. Never used when NODE_ENV=production. */
export const DEV_AGENT_PRINCIPAL_KEY_SECRET = 'dev-only-agent-principal-key-secret-do-not-deploy'

export function agentPrincipalKeySecretFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { isProd: boolean },
): string {
  const raw = env['AGENT_PRINCIPAL_KEY_SECRET']?.trim() ?? ''
  if (raw === '') {
    if (opts.isProd) {
      throw new Error(
        'AGENT_PRINCIPAL_KEY_SECRET must be set in production (at least ' +
          `${AGENT_PRINCIPAL_KEY_SECRET_MIN_LENGTH} characters, e.g. \`openssl rand -base64 48\`)`,
      )
    }
    return DEV_AGENT_PRINCIPAL_KEY_SECRET
  }
  if (raw.length < AGENT_PRINCIPAL_KEY_SECRET_MIN_LENGTH) {
    throw new Error(
      `AGENT_PRINCIPAL_KEY_SECRET must be at least ${AGENT_PRINCIPAL_KEY_SECRET_MIN_LENGTH} characters`,
    )
  }
  if (opts.isProd && raw === DEV_AGENT_PRINCIPAL_KEY_SECRET) {
    throw new Error('AGENT_PRINCIPAL_KEY_SECRET must not be the dev-only default in production')
  }
  return raw
}

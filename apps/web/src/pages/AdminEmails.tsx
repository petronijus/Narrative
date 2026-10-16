/**
 * pages/AdminEmails.tsx
 *
 * Administration → Emails (docs/adr/0014): every kind of email Narrative
 * sends, grouped, with who gets it; an admin turns each kind on or off for
 * the whole instance and previews it with sample data. The server keeps the
 * switches (`email_settings`) and asks them before every send.
 */

import { useCallback, useEffect, useState } from 'react'
import { Eye, Mail } from 'lucide-react'
import { ApiError, useApi, type EmailKindSetting } from '../api/client.js'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const GROUP_ORDER = ['Sharing', 'People', 'Security', 'Agents']

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

export function AdminEmails() {
  const api = useApi()
  const [kinds, setKinds] = useState<EmailKindSetting[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ label: string; subject: string; html: string } | null>(
    null,
  )

  const load = useCallback(async () => {
    try {
      setKinds(await api.listEmailKinds())
      setError(null)
    } catch (err) {
      setError(message(err, 'Could not load the email settings.'))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (kind: EmailKindSetting) => {
    setBusy(kind.kind)
    setError(null)
    try {
      const updated = await api.setEmailEnabled(kind.kind, !kind.enabled)
      setKinds((prev) => prev.map((k) => (k.kind === updated.kind ? updated : k)))
    } catch (err) {
      setError(message(err, 'Could not change that setting. Try again.'))
    } finally {
      setBusy(null)
    }
  }

  const openPreview = async (kind: EmailKindSetting) => {
    setError(null)
    try {
      const { subject, html } = await api.previewEmail(kind.kind)
      setPreview({ label: kind.label, subject, html })
    } catch (err) {
      setError(message(err, 'Could not render the preview.'))
    }
  }

  const groups = GROUP_ORDER.map((g) => ({
    name: g,
    items: kinds.filter((k) => k.group === g),
  })).filter((g) => g.items.length > 0)
  const on = kinds.filter((k) => k.enabled).length

  return (
    <section className="grid gap-4">
      <div className="max-w-xl">
        <h2 className="text-base font-semibold text-foreground">Emails</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every email Narrative sends, for everyone on this instance. A kind that is off is not sent
          at all{kinds.length > 0 && ` — ${on} of ${kinds.length} are on`}.
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground"
        >
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        groups.map((group) => (
          <div key={group.name} className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.name}
            </h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {group.items.map((kind) => {
                const switchId = `email-${kind.kind}`
                return (
                  <li key={kind.kind} className="flex items-start gap-3 px-4 py-3">
                    <Mail
                      className={`mt-0.5 h-4 w-4 shrink-0 ${kind.enabled ? 'text-foreground' : 'text-muted-foreground/40'}`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor={switchId}
                        className={`text-sm font-medium ${kind.enabled ? 'text-foreground' : 'text-muted-foreground'}`}
                      >
                        {kind.label}
                      </label>
                      <p className="mt-0.5 text-xs text-muted-foreground">{kind.description}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground/70">
                        To: {kind.recipient}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 gap-1.5"
                      aria-label={`Preview the ${kind.label} email`}
                      onClick={() => void openPreview(kind)}
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      Preview
                    </Button>
                    <button
                      id={switchId}
                      type="button"
                      role="switch"
                      aria-checked={kind.enabled}
                      aria-label={`${kind.label} email ${kind.enabled ? 'on' : 'off'}`}
                      disabled={busy === kind.kind}
                      onClick={() => void toggle(kind)}
                      className={`relative mt-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 ${kind.enabled ? 'bg-primary' : 'bg-muted'}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${kind.enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      )}

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          {preview !== null && (
            <>
              <DialogHeader>
                <DialogTitle>{preview.label}</DialogTitle>
                <DialogDescription>Subject: {preview.subject}</DialogDescription>
              </DialogHeader>
              {/* No scripts in an email; the sandbox keeps it that way. */}
              <iframe
                title={`${preview.label} email preview`}
                sandbox=""
                srcDoc={preview.html}
                className="h-[70vh] w-full rounded-md border border-border bg-white"
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

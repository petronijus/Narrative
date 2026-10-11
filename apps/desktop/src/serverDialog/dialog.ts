/**
 * serverDialog/dialog.ts
 *
 * The script of the "Custom Server…" window, inlined into its page by
 * scripts/build.mjs (the page's CSP admits exactly this script by hash). It
 * talks to the main process only through `window.narrativeServerDialog`
 * (serverDialog/preload.ts); the main process validates the address again.
 */

interface ServerDialogBridge {
  initial(): Promise<string>
  submit(origin: string): Promise<{ ok: true } | { ok: false; error: string }>
  cancel(): void
}

const bridge = (window as unknown as { narrativeServerDialog: ServerDialogBridge })
  .narrativeServerDialog
const form = document.getElementById('form') as HTMLFormElement
const input = document.getElementById('origin') as HTMLInputElement
const error = document.getElementById('error') as HTMLDivElement

void bridge.initial().then((value) => {
  input.value = value
  input.select()
})
input.focus()

form.addEventListener('submit', (event) => {
  event.preventDefault()
  error.textContent = ''
  void bridge.submit(input.value).then((result) => {
    if (!result.ok) {
      error.textContent = result.error
      input.focus()
    }
  })
})

document.getElementById('cancel')!.addEventListener('click', () => bridge.cancel())
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') bridge.cancel()
})

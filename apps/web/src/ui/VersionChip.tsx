/**
 * ui/VersionChip.tsx
 *
 * Bottom-left fixed version indicator. Shows the build version injected
 * by Vite's `__BUILD_VERSION__` define. Hidden in test env so it doesn't
 * interfere with e2e screenshot diffs / aria-label queries.
 *
 * The version string auto-bumps via the commit-count scheme wired in
 * `apps/web/vite.config.ts` — every new commit ⇒ count + 1, shown next
 * to the short SHA. See `docs/handoff/polish-p1-visual-foundation.md`
 * for the full rationale.
 */

declare const __BUILD_VERSION__: string

export function VersionChip() {
  const version = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev'
  return (
    <div
      className="pointer-events-none fixed bottom-2 left-2 z-50 select-none rounded-md px-2 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      aria-hidden="true"
      title="Build version"
    >
      {version}
    </div>
  )
}

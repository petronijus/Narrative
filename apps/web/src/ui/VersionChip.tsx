/**
 * ui/VersionChip.tsx
 *
 * Build-version text shown at the bottom-left of every page inside the
 * global chrome row (see App.tsx). Pure inline element — positioning
 * comes from the parent.
 *
 * The version string auto-bumps via the commit-count scheme wired in
 * `apps/web/vite.config.ts` — every new commit ⇒ count + 1, shown
 * next to the short SHA.
 */

declare const __BUILD_VERSION__: string

export function VersionChip() {
  const version = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev'
  return (
    <span
      className="select-none rounded-md px-2 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground/60"
      aria-hidden="true"
      title="Build version"
    >
      {version}
    </span>
  )
}

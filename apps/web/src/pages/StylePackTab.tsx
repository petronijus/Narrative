/**
 * pages/StylePackTab.tsx — the folder's style pack in Folder Settings
 * (agentic A4.6): what the brand is, read live from the folder document
 * (`useFolderStylePack`), and the values people tune.
 *
 *   - Colours and variants, fonts, text styles, layouts as small previews
 *     drawn from their regions (a layout's regions edited in fractions of
 *     the slide), components, the editorial rules and the QA rule levels.
 *   - Every change runs `style.pack.edit` through the command API — the
 *     door an agent uses — as a merge patch; the server validates the
 *     whole pack and writes the folder document, which comes back here.
 *   - Compile makes the pack the folder's tokens and component masters;
 *     the pack as JSON is exported and imported whole for everything else.
 *
 * A viewer of the folder sees it read-only.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Download, Hammer, Trash2, Upload } from 'lucide-react'
import {
  QA_RULE_DEFAULT_LEVELS,
  QA_RULE_IDS,
  type ColorRef,
  type PackLayout,
  type PackRegion,
  type StylePack,
} from '@narrative/shared'
import { Button } from '@/components/ui/button'
import { useApi } from '../api/client.js'
import { useFolderStylePack } from '../state/FolderDocProvider.js'

interface Compiled {
  colors: { created: number; updated: number }
  textStyles: { created: number; updated: number }
  components: { created: number; updated: number }
  missingFonts: string[]
}

const REGION_FILL: Readonly<Record<PackRegion['type'], string>> = {
  text: 'rgba(59,130,246,0.25)',
  image: 'rgba(16,185,129,0.25)',
  chart: 'rgba(234,179,8,0.25)',
  table: 'rgba(168,85,247,0.25)',
}

/** A pack colour reference as hex, on the axes' default values (the preview's). */
function refHex(pack: StylePack, ref: ColorRef | undefined, depth = 0): string | undefined {
  if (ref === undefined || depth > 4) return undefined
  if (ref.startsWith('#')) return ref.slice(0, 7)
  if (ref.startsWith('color:')) return pack.tokens.colors[ref.slice(6)]?.value.slice(0, 7)
  const role = ref.slice(5)
  for (const axis of pack.tokens.axes) {
    const value = axis.values.find((v) => v.id === axis.default) ?? axis.values[0]
    const r = (value?.roles as Record<string, ColorRef | undefined> | undefined)?.[role]
    if (r !== undefined) return refHex(pack, r, depth + 1)
  }
  return undefined
}

export function StylePackTab({ folderId, editable }: { folderId: string; editable: boolean }) {
  const pack = useFolderStylePack()
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [compiled, setCompiled] = useState<Compiled | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const edit = useCallback(
    async (input: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      setBusy(true)
      setError(null)
      try {
        return await api.runFolderCommand<Record<string, unknown>>(
          folderId,
          'style.pack.edit',
          input,
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The change failed')
        return null
      } finally {
        setBusy(false)
      }
    },
    [api, folderId],
  )
  const patch = useCallback(
    (p: Record<string, unknown>) => void edit({ op: 'update', patch: p }),
    [edit],
  )

  const importFile = async (file: File) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      setError(`${file.name} is not JSON`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError(`${file.name} is not a style pack`)
      return
    }
    await edit({ op: 'set', pack: parsed })
  }

  // The pack as the server holds it, through the agent's door (style.pack.get).
  const exportPack = async () => {
    if (pack == null) return
    let value: { id: string } | null
    try {
      ;({ value } = await api.runFolderCommand<{ value: { id: string } | null }>(
        folderId,
        'style.pack.get',
        { part: 'pack' },
      ))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The export failed')
      return
    }
    if (value === null) {
      setError('The folder has no style pack')
      return
    }
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${value.id}.stylepack.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importButton = editable && (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label="Style pack JSON file"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file !== undefined) void importFile(file)
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        data-action="stylePack.import"
      >
        <Upload className="h-4 w-4" aria-hidden="true" />
        Import JSON
      </Button>
    </>
  )

  if (pack === undefined) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>
  }

  return (
    <div className="space-y-8 p-8" data-testid="style-pack-tab">
      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground"
        >
          {error}
        </div>
      )}

      {pack === null ? (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This folder has no style pack. A style pack holds a brand as layouts, text styles,
            colour variants, components and rules; agents build and check slides with it.
          </p>
          {importButton}
        </section>
      ) : (
        <>
          <section className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <h2 className="text-lg font-semibold">{pack.name}</h2>
              <p className="text-xs text-muted-foreground">
                {pack.id} · {pack.layouts.length} layouts · {pack.components.length} components
              </p>
            </div>
            {editable && (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={busy}
                onClick={() =>
                  void edit({ op: 'compile' }).then((r) => {
                    if (r !== null) setCompiled(r['compiled'] as Compiled)
                  })
                }
                data-action="stylePack.compile"
              >
                <Hammer className="h-4 w-4" aria-hidden="true" />
                Compile
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => void exportPack()}
              data-action="stylePack.export"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Export JSON
            </Button>
            {importButton}
            {editable && (
              <Button
                size="sm"
                variant={confirmDelete ? 'destructive' : 'ghost'}
                className="gap-1.5"
                disabled={busy}
                onBlur={() => setConfirmDelete(false)}
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true)
                    return
                  }
                  setConfirmDelete(false)
                  void edit({ op: 'delete' })
                }}
                data-action="stylePack.delete"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {confirmDelete ? 'Delete the pack?' : 'Delete'}
              </Button>
            )}
          </section>

          {compiled !== null && (
            <p className="rounded-md bg-surface-2 px-4 py-2 text-sm" data-testid="pack-compiled">
              Compiled: {compiled.colors.created + compiled.colors.updated} colours,{' '}
              {compiled.textStyles.created + compiled.textStyles.updated} text styles,{' '}
              {compiled.components.created} components created and {compiled.components.updated}{' '}
              updated.
              {compiled.missingFonts.length > 0 &&
                ` Upload these fonts in the Fonts tab: ${compiled.missingFonts.join(', ')}.`}
            </p>
          )}

          <ColoursSection pack={pack} editable={editable && !busy} onPatch={patch} />
          <FontsSection pack={pack} />
          <LayoutsSection pack={pack} editable={editable && !busy} onPatch={patch} />
          <ComponentsSection pack={pack} />
          <RulesSection pack={pack} editable={editable && !busy} onPatch={patch} />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold text-foreground">{children}</h3>
}

function ColoursSection({
  pack,
  editable,
  onPatch,
}: {
  pack: StylePack
  editable: boolean
  onPatch: (p: Record<string, unknown>) => void
}) {
  return (
    <section>
      <SectionTitle>Colours and variants</SectionTitle>
      <div className="flex flex-wrap gap-4">
        {Object.entries(pack.tokens.colors).map(([key, c]) => (
          <label key={key} className="flex w-36 flex-col gap-1 text-xs">
            <span
              className="h-10 rounded-md border border-border"
              style={{ background: c.value }}
              aria-hidden="true"
            />
            <span className="font-medium">{c.name}</span>
            <input
              key={c.value}
              defaultValue={c.value}
              disabled={!editable}
              aria-label={`${c.name} colour`}
              className="rounded-xs border border-border bg-surface-1 px-1.5 py-0.5 font-mono"
              onBlur={(e) => {
                const value = e.target.value.trim().toLowerCase()
                if (value !== c.value.toLowerCase())
                  onPatch({ tokens: { colors: { [key]: { value } } } })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
          </label>
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {pack.tokens.axes.map((axis) => (
          <div key={axis.id} className="text-xs">
            <span className="font-medium">{axis.name}:</span>{' '}
            {axis.values.map((v) => (
              <span key={v.id} className="mr-3 inline-flex items-center gap-1">
                {Object.entries(v.roles).map(([role, ref]) => (
                  <span
                    key={role}
                    title={`${role}: ${ref}`}
                    className="inline-block h-3 w-3 rounded-full border border-border"
                    style={{ background: refHex(pack, ref) }}
                  />
                ))}
                {v.name}
                {v.id === axis.default && ' (default)'}
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

function FontsSection({ pack }: { pack: StylePack }) {
  return (
    <section>
      <SectionTitle>Fonts and text styles</SectionTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 text-xs">
        {Object.entries(pack.fonts).map(([id, f]) => (
          <div key={id} className="rounded-md border border-border px-3 py-2">
            <div className="font-medium">{id}</div>
            <div className="text-muted-foreground">
              {f.family} {f.weight}
              {f.stretch !== undefined && ` · width ${f.stretch}%`}
            </div>
          </div>
        ))}
      </div>
      <table className="mt-3 w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Style</th>
            <th className="font-normal">Font</th>
            <th className="font-normal">Size</th>
            <th className="font-normal">Line</th>
            <th className="font-normal">Colour</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(pack.textStyles).map(([id, s]) => (
            <tr key={id} className="border-t border-border">
              <td className="py-1">{s.name}</td>
              <td>{s.font}</td>
              <td>
                {s.size}
                {s.minSize !== undefined && ` (≥ ${s.minSize})`}
              </td>
              <td>{s.lineSpacing ?? s.lineHeight ?? '—'}</td>
              <td>{s.color}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** A layout drawn from its regions, 16:9. */
function LayoutPreview({ pack, layout }: { pack: StylePack; layout: PackLayout }) {
  return (
    <svg viewBox="0 0 160 90" className="w-full rounded-sm border border-border" aria-hidden="true">
      <rect width="160" height="90" fill={refHex(pack, layout.background ?? 'role:background')} />
      {layout.regions.map((r, i) => (
        <g key={i}>
          <rect
            x={r.rect[0] * 160}
            y={r.rect[1] * 90}
            width={r.rect[2] * 160}
            height={r.rect[3] * 90}
            fill={REGION_FILL[r.type]}
            stroke="currentColor"
            strokeOpacity={0.4}
            strokeWidth={0.4}
          />
          <text x={r.rect[0] * 160 + 1.5} y={r.rect[1] * 90 + 5} fontSize={4} fill="currentColor">
            {r.slot}
          </text>
        </g>
      ))}
    </svg>
  )
}

function LayoutsSection({
  pack,
  editable,
  onPatch,
}: {
  pack: StylePack
  editable: boolean
  onPatch: (p: Record<string, unknown>) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const layout = pack.layouts.find((l) => l.id === selected)
  return (
    <section>
      <SectionTitle>Layouts</SectionTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
        {pack.layouts.map((l) => (
          <button
            key={l.id}
            onClick={() => setSelected(l.id === selected ? null : l.id)}
            aria-pressed={l.id === selected}
            className={[
              'rounded-md p-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent',
              l.id === selected ? 'bg-accent ring-1 ring-primary' : '',
            ].join(' ')}
          >
            <LayoutPreview pack={pack} layout={l} />
            <div className="mt-1 truncate font-medium text-foreground">{l.name}</div>
            <div className="line-clamp-2">{l.purpose}</div>
          </button>
        ))}
      </div>
      {layout !== undefined && (
        <RegionEditor key={layout.id} layout={layout} editable={editable} onPatch={onPatch} />
      )}
    </section>
  )
}

const RECT_FIELDS = ['x', 'y', 'width', 'height'] as const

function RegionEditor({
  layout,
  editable,
  onPatch,
}: {
  layout: PackLayout
  editable: boolean
  onPatch: (p: Record<string, unknown>) => void
}) {
  const setRect = (index: number, field: number, value: number) => {
    const regions = layout.regions.map((r, i) => {
      if (i !== index) return r
      const rect = [...r.rect] as PackRegion['rect']
      rect[field] = value
      return { ...r, rect }
    })
    onPatch({ layouts: { [layout.id]: { regions } } })
  }
  return (
    <div className="mt-4 rounded-md border border-border p-3" data-testid="region-editor">
      <div className="mb-2 text-xs text-muted-foreground">
        {layout.name}: regions in fractions of the slide (0–1)
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Slot</th>
            <th className="font-normal">Role</th>
            <th className="font-normal">Type</th>
            {RECT_FIELDS.map((f) => (
              <th key={f} className="font-normal">
                {f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {layout.regions.map((r, i) => (
            <tr key={`${r.slot}-${i}`} className="border-t border-border">
              <td className="py-1">{r.slot}</td>
              <td>{r.role}</td>
              <td>{r.type}</td>
              {RECT_FIELDS.map((f, k) => (
                <td key={f}>
                  <input
                    key={r.rect[k]}
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    defaultValue={r.rect[k]}
                    disabled={!editable}
                    aria-label={`${r.slot} ${f}`}
                    className="w-16 rounded-xs border border-border bg-surface-1 px-1 py-0.5"
                    onBlur={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v) && v !== r.rect[k]) setRect(i, k, v)
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ComponentsSection({ pack }: { pack: StylePack }) {
  if (pack.components.length === 0) return null
  return (
    <section>
      <SectionTitle>Components</SectionTitle>
      <ul className="space-y-1 text-xs">
        {pack.components.map((c) => (
          <li key={c.id}>
            <span className="font-medium">{c.name}</span>{' '}
            <span className="text-muted-foreground">
              ({c.kind}, {c.objects.length} objects)
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RulesSection({
  pack,
  editable,
  onPatch,
}: {
  pack: StylePack
  editable: boolean
  onPatch: (p: Record<string, unknown>) => void
}) {
  const { editorial, qa } = pack
  const sentinels = useMemo(() => qa.sentinels.join(', '), [qa.sentinels])
  return (
    <section>
      <SectionTitle>Editorial and QA rules</SectionTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 text-xs">
        <label className="flex items-center justify-between gap-2">
          Title: at most words
          <input
            key={editorial.title.maxWords ?? 'none'}
            type="number"
            min={1}
            max={100}
            defaultValue={editorial.title.maxWords ?? ''}
            disabled={!editable}
            className="w-16 rounded-xs border border-border bg-surface-1 px-1 py-0.5"
            onBlur={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value)
              if (v !== (editorial.title.maxWords ?? null))
                onPatch({ editorial: { title: { maxWords: v } } })
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          Title ending in a period
          <select
            value={editorial.title.trailingPeriod}
            disabled={!editable}
            className="rounded-xs border border-border bg-surface-1 px-1 py-0.5"
            onChange={(e) => onPatch({ editorial: { title: { trailingPeriod: e.target.value } } })}
          >
            <option value="forbid">forbidden</option>
            <option value="allow">allowed</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Capitals
          <select
            value={editorial.allCaps}
            disabled={!editable}
            className="rounded-xs border border-border bg-surface-1 px-1 py-0.5"
            onChange={(e) => onPatch({ editorial: { allCaps: e.target.value } })}
          >
            <option value="forbid">never</option>
            <option value="styles-only">from text styles only</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Smallest body size (px)
          <input
            key={editorial.minBodySize ?? 'none'}
            type="number"
            min={1}
            defaultValue={editorial.minBodySize ?? ''}
            disabled={!editable}
            className="w-16 rounded-xs border border-border bg-surface-1 px-1 py-0.5"
            onBlur={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value)
              if (v !== (editorial.minBodySize ?? null)) onPatch({ editorial: { minBodySize: v } })
            }}
          />
        </label>
        <label className="col-span-full flex items-center gap-2">
          Placeholder text
          <input
            key={sentinels}
            defaultValue={sentinels}
            disabled={!editable}
            className="flex-1 rounded-xs border border-border bg-surface-1 px-1.5 py-0.5"
            onBlur={(e) => {
              const list = e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s !== '')
              if (list.join(', ') !== sentinels) onPatch({ qa: { sentinels: list } })
            }}
          />
        </label>
      </div>
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 text-xs">
        {QA_RULE_IDS.map((rule) => (
          <label key={rule} className="flex items-center justify-between gap-2">
            {rule}
            <select
              value={qa.rules?.[rule] ?? 'default'}
              disabled={!editable}
              aria-label={`${rule} level`}
              className="rounded-xs border border-border bg-surface-1 px-1 py-0.5"
              onChange={(e) =>
                onPatch({
                  qa: { rules: { [rule]: e.target.value === 'default' ? null : e.target.value } },
                })
              }
            >
              <option value="default">default ({QA_RULE_DEFAULT_LEVELS[rule]})</option>
              <option value="error">error</option>
              <option value="warn">warning</option>
              <option value="off">off</option>
            </select>
          </label>
        ))}
      </div>
    </section>
  )
}

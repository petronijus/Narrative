/**
 * components/DeckShell.tsx
 *
 * M5: Shared layout wrapper pro /deck/:id a /deck/:id/present routes.
 *
 * Účel: vyhoupnout SlideDocProvider nad obě routes tak, aby Y.Doc + WebSocket
 * connection přežily navigaci editor ↔ present mode bez reconnect.
 *
 * Pattern:
 *   <Route path="/deck/:id" element={<DeckShell />}>
 *     <Route index element={<DeckEditor />} />
 *     <Route path="present" element={<DeckPresent />} />
 *   </Route>
 *
 * DeckEditor a DeckPresent dědí Y.Doc přes SlideDocContext — žádný reconnect
 * při navigaci mezi těmito dvěma child routes.
 *
 * M6: Přidán CanvasInstanceContext  (varianta B — state lifting).
 * Canvas.tsx volá onReady(instance) po Pixi init → DeckShell uloží do state →
 * context je dostupný pro PresentLayout + EditorLayout bez přímé závislosti na Canvas.
 *
 * M10: DeckRoleProvider added to expose per-deck role to all child components.
 *
 * M11: MediaUploadProvider added for tus resumable uploads.
 *      Scoped to editor routes only (DeckShell excludes PresentLayout from uploads
 *      via role gating + component-level guards, but the provider is present in both
 *      child routes for simplicity — upload state is simply unused in present mode).
 *
 * M16 P2: FolderDocProvider wraps children inside DeckRoleProvider so the
 *   design-token Y.Doc for the deck's folder is available to all editor children.
 *   FolderDocGate reads folderId from DeckRoleContext (set after the deck list fetch)
 *   and passes it down; the providers stay mounted from the first render and
 *   open the folder Hocuspocus doc once folderId turns non-null.
 *   TokensProvider is mounted inside FolderDocGate to expose a synchronous
 *   colour resolver to the renderer tree.
 */

import { useState, useCallback, useLayoutEffect, useEffect, useRef } from 'react'
import { markDeckLoadStart } from '../state/loadTimings.js'
import { TOKEN_PROPAGATION_ORIGIN } from '../state/origins.js'
import { useParams, Navigate, Outlet } from 'react-router-dom'
import { SlideDocProvider } from '../state/SlideDocProvider.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { ActiveSlideProvider } from '../state/ActiveSlideContext.js'
import {
  listSlides,
  getSlideObjectsCtx,
  updateObject,
  isTokenRef,
  resolveTokenValue,
} from '@narrative/slide-model'
import type { TextObject, SlideObjectPatch, TextStyleOverrideKey } from '@narrative/shared'
import type { TextStyleTokenSnapshot, FolderTokensSnapshot } from '@narrative/slide-model'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { DeckRoleProvider, useDeckRole } from '../state/DeckRoleContext.js'
import { MediaUploadProvider } from '../state/useMediaUpload.js'
import { RulersProvider } from '../state/RulersContext.js'
import { SnappingProvider } from '../state/SnappingContext.js'
import {
  FolderDocProvider,
  useFolderTokens,
  useFolderTokensOptional,
} from '../state/FolderDocProvider.js'
import { FolderFontsProvider } from '../state/useFolderFonts.js'
import { FolderFontLoader } from '../state/FolderFontLoader.js'
import { DeckFontsProvider } from '../state/useDeckFonts.js'
import { TokensProvider, useTokensResolve } from '../state/TokensContext.js'
import { setColourResolver } from '../renderer/colourResolver.js'

export interface DeckShellContextValue {
  /**
   * Callback pro Canvas.tsx — volá se po Pixi inicializaci a při unmount (null).
   * Null cleanup signal je důležitý pro edit ↔ present navigaci: bez něj by
   * canvasInstance state držel referenci na zničený SceneGraph během remount okna.
   */
  onCanvasReady: (instance: CanvasInstance | null) => void
}

// ---------------------------------------------------------------------------
// Inner gate — reads folderId from DeckRoleContext (already inside DeckRoleProvider)
// ---------------------------------------------------------------------------

interface FolderDocGateProps {
  children: React.ReactNode
}

/**
 * Renders children inside the folder-scoped providers.
 *
 * `folderId` is null for the first few hundred milliseconds of a deck
 * open — it arrives with the deck-role fetch. The element tree here must
 * NOT change shape when it flips: this gate sits directly above
 * SlideDocProvider, the Pixi canvas and the slides panel, so swapping the
 * wrapper components out makes React unmount and rebuild the whole
 * editor. That was visible as the slide sidebar populating, blanking and
 * re-populating mid-load (plus a second deck Y.Doc WebSocket and a
 * duplicate deck fetch).
 *
 * So the providers are always mounted and take `folderId: string | null`
 * themselves: with a null id they hold an empty font list and the
 * empty-token placeholder snapshot, which resolves colours exactly like
 * the old `tokens={null}` branch did.
 */
export function FolderDocGate({ children }: FolderDocGateProps) {
  const { folderId } = useDeckRole()

  return (
    <FolderFontsProvider folderId={folderId}>
      <FolderFontLoader />
      <FolderDocProvider folderId={folderId}>
        <FolderTokensBridge>{children}</FolderTokensBridge>
      </FolderDocProvider>
    </FolderFontsProvider>
  )
}

/**
 * Reads the live token snapshot from FolderDocProvider and passes it to
 * TokensProvider.  Separate component so it sits inside FolderDocProvider.
 */
function FolderTokensBridge({ children }: { children: React.ReactNode }) {
  const tokens = useFolderTokens()
  return (
    <TokensProvider tokens={tokens}>
      <ColourResolverInstaller />
      {children}
    </TokensProvider>
  )
}

/**
 * Installs the React-side token colour resolver into the module-level
 * singleton in colourResolver.ts so the Pixi object renderers can call
 * resolveColour() synchronously without going through React hooks.
 *
 * Must sit inside <TokensProvider> so useTokensResolve() is available.
 * Uninstalls on unmount (setColourResolver(null)).
 */
function ColourResolverInstaller() {
  const resolve = useTokensResolve()
  useEffect(() => {
    setColourResolver(resolve)
    return () => {
      setColourResolver(null)
    }
  }, [resolve])
  return null
}

// ---------------------------------------------------------------------------
// DeckShell
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TextStylePropagator
//
// Watches the folder text-style tokens and re-applies any token field
// change onto every TextObject in this deck that's linked to that
// token (`textStyleId`), skipping fields the user has explicitly
// overridden on a per-object basis (`textStyleOverrides`).
//
// Key shape we write per typography field:
//   - fontFamily ← TextStyleTokenSnapshot.family
//   - fontWeight ← TextStyleTokenSnapshot.weight
//   - fontSize   ← TextStyleTokenSnapshot.size
//   - lineHeight ← TextStyleTokenSnapshot.lineHeight
//   - letterSpacing ← TextStyleTokenSnapshot.letterSpacing
//   - color      ← TextStyleTokenSnapshot.color (hex → number, or TokenRef)
//   - textTransform ← TextStyleTokenSnapshot.textTransform (or 'none')
//
// Runs:
//   1. On first sync (so reopening a deck reconciles every linked
//      TextObject with the current token state).
//   2. On every subsequent token change in the folder Y.Doc.
// ---------------------------------------------------------------------------

const PROPAGATED_KEYS: ReadonlyArray<TextStyleOverrideKey> = [
  'fontFamily',
  'fontWeight',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'paragraphSpaceBefore',
  'paragraphSpaceAfter',
  'color',
  'textTransform',
]

function tokenFieldFor(
  style: TextStyleTokenSnapshot,
  key: TextStyleOverrideKey,
  tokens: FolderTokensSnapshot,
): unknown {
  switch (key) {
    case 'fontFamily':
      return style.family
    case 'fontWeight':
      return style.weight
    case 'fontSize':
      return style.size
    case 'lineHeight':
      return style.lineHeight
    case 'letterSpacing':
      return style.letterSpacing
    case 'paragraphSpaceBefore':
      return style.paragraphSpaceBefore ?? 0
    case 'paragraphSpaceAfter':
      return style.paragraphSpaceAfter ?? 0
    case 'color': {
      const c = style.color
      if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) {
        return parseInt(c.slice(1), 16)
      }
      if (c !== undefined && isTokenRef(c)) {
        const resolved = resolveTokenValue(c, tokens)
        if (resolved !== null && /^#[0-9a-f]{6}$/i.test(resolved)) {
          return parseInt(resolved.slice(1), 16)
        }
        // Pass the TokenRef through — renderer resolves on demand.
        return c
      }
      return undefined
    }
    case 'textTransform':
      return style.textTransform ?? 'none'
  }
}

function TextStylePropagator() {
  // Optional — FolderDocGate renders children with no provider when
  // folderId hasn't loaded yet (and decks without a folder skip the
  // provider entirely). Bail until tokens are available.
  const tokens = useFolderTokensOptional()
  const { deckCtx } = useSlideDoc()
  const prevRef = useRef<Record<string, TextStyleTokenSnapshot> | null>(null)

  useEffect(() => {
    if (tokens === null) return
    const prev = prevRef.current
    prevRef.current = tokens.textStyles

    // First mount with an empty token snapshot — wait for sync.
    if (Object.keys(tokens.textStyles).length === 0 && prev === null) return

    // Compute the set of token ids whose value diverges from the
    // previous snapshot (or every id present, on first run).
    const changedIds = new Set<string>()
    if (prev === null) {
      for (const id of Object.keys(tokens.textStyles)) changedIds.add(id)
    } else {
      const allIds = new Set<string>([...Object.keys(prev), ...Object.keys(tokens.textStyles)])
      for (const id of allIds) {
        const before = prev[id]
        const after = tokens.textStyles[id]
        // Cheap deep-ish equality: stringify the tracked fields.
        const sigBefore = before
          ? JSON.stringify([
              before.family,
              before.weight,
              before.size,
              before.lineHeight,
              before.letterSpacing,
              before.paragraphSpaceBefore,
              before.paragraphSpaceAfter,
              before.color,
              before.textTransform,
            ])
          : null
        const sigAfter = after
          ? JSON.stringify([
              after.family,
              after.weight,
              after.size,
              after.lineHeight,
              after.letterSpacing,
              after.paragraphSpaceBefore,
              after.paragraphSpaceAfter,
              after.color,
              after.textTransform,
            ])
          : null
        if (sigBefore !== sigAfter) changedIds.add(id)
      }
    }
    if (changedIds.size === 0) return

    // Walk every slide and patch matching linked TextObjects. The
    // mutation is read-modify-write, so we batch all writes in a
    // single Yjs transaction at the deck-doc level for atomicity and
    // a single observer fan-out.
    //
    // Untracked ON PURPOSE: TOKEN_PROPAGATION_ORIGIN is the outermost
    // origin, so it overrides the LOCAL_ORIGIN of the updateObject calls
    // inside and keeps this write off the deck's undo stack — Mod+Z must
    // not desync linked text from its folder token (see state/origins.ts;
    // propagation moves server-side in phase A2 of the agentic-layer plan).
    const slides = listSlides(deckCtx)
    deckCtx.doc.transact(() => {
      for (const slide of slides) {
        const objCtx = getSlideObjectsCtx(deckCtx, slide.id)
        if (objCtx === null) continue
        for (const obj of slide.objects) {
          if (obj.type !== 'text') continue
          const textObj = obj as TextObject & { textStyleId?: string }
          const sid = textObj.textStyleId
          if (sid === undefined || !changedIds.has(sid)) continue
          const style = tokens.textStyles[sid]
          if (style === undefined) continue
          const overrides = new Set<string>(textObj.textStyleOverrides ?? [])
          const patch: Record<string, unknown> = {}
          for (const key of PROPAGATED_KEYS) {
            if (overrides.has(key)) continue
            const next = tokenFieldFor(style, key, tokens)
            if (next === undefined) continue
            // Only emit when the value actually differs — avoids
            // useless writes that would still trigger reconciler
            // patches downstream.
            const cur = (textObj as unknown as Record<string, unknown>)[key]
            if (cur === next) continue
            patch[key] = next
          }
          if (Object.keys(patch).length > 0) {
            updateObject(objCtx, textObj.id, patch as SlideObjectPatch<TextObject>)
          }
        }
      }
    }, TOKEN_PROPAGATION_ORIGIN)
  }, [tokens, deckCtx])

  return null
}

// (removed) ComponentDeleteCascadeEffect — components are now stamps,
// so deleting a master never needs to remove "instances" from decks
// (there are no instances). Stamped primitives stay on the slide.

export function DeckShell() {
  const { id } = useParams<{ id: string }>()
  const [canvasInstance, setCanvasInstance] = useState<CanvasInstance | null>(null)

  // P12d: stamp t0 for the perf HUD's load-time breakdown. Re-stamps
  // whenever the deckId changes so each navigation gets a fresh
  // ws → sync → pixi → paint timeline. Layout effect so we beat the
  // SlideDocProvider's own effect that creates the WS.
  useLayoutEffect(() => {
    if (id !== undefined && id !== '') {
      markDeckLoadStart()
    }
  }, [id])

  const handleCanvasReady = useCallback((instance: CanvasInstance | null) => {
    setCanvasInstance(instance)
  }, [])

  if (id === undefined || id === '') {
    return <Navigate to="/" replace />
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
      <DeckRoleProvider deckId={id}>
        <DeckFontsProvider deckId={id}>
          <FolderDocGate>
            <SlideDocProvider deckId={id}>
              <ActiveSlideProvider>
                <MediaUploadProvider deckId={id}>
                  <RulersProvider>
                    <SnappingProvider>
                      <CanvasInstanceContext value={canvasInstance}>
                        {/* Propagates folder text-style token edits onto
                          every linked TextObject in this deck, skipping
                          per-object override fields. */}
                        <TextStylePropagator />
                        <Outlet
                          context={
                            { onCanvasReady: handleCanvasReady } satisfies DeckShellContextValue
                          }
                        />
                      </CanvasInstanceContext>
                    </SnappingProvider>
                  </RulersProvider>
                </MediaUploadProvider>
              </ActiveSlideProvider>
            </SlideDocProvider>
          </FolderDocGate>
        </DeckFontsProvider>
      </DeckRoleProvider>
    </div>
  )
}

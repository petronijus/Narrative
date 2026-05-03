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
 * M6: Přidán CanvasInstanceContext.Provider (varianta B — state lifting).
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
 *   and opens the folder Hocuspocus doc once folderId is known.
 *   TokensProvider is mounted inside FolderDocGate to expose a synchronous
 *   colour resolver to the renderer tree.
 */

import { useState, useCallback, useLayoutEffect, useEffect, useRef } from 'react'
import { markDeckLoadStart } from '../state/loadTimings.js'
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
  removeComponentInstancesFromDoc,
} from '@narrative/slide-model'
import type { TextObject, SlideObjectPatch, TextStyleOverrideKey } from '@narrative/shared'
import type { TextStyleTokenSnapshot, FolderTokensSnapshot } from '@narrative/slide-model'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { DeckRoleProvider, useDeckRole } from '../state/DeckRoleContext.js'
import { MediaUploadProvider } from '../state/useMediaUpload.js'
import { RulersProvider } from '../state/RulersContext.js'
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
 * Renders children inside FolderDocProvider once folderId is known.
 * While folderId is null (loading), renders children without a folder doc.
 * This avoids a visual loading gate — the editor mounts immediately and
 * gains token resolution once the folder doc syncs.
 */
function FolderDocGate({ children }: FolderDocGateProps) {
  const { folderId } = useDeckRole()

  if (!folderId) {
    // No folderId yet — render with a null tokens snapshot (TokensProvider
    // falls back to literal hex conversion).
    return (
      <TokensProvider tokens={null}>
        <ColourResolverInstaller />
        {children}
      </TokensProvider>
    )
  }

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
    })
  }, [tokens, deckCtx])

  return null
}

// ---------------------------------------------------------------------------
// ComponentDeleteCascadeEffect
//
// Two complementary paths — both call removeComponentInstancesFromDoc
// when a master is deleted:
//
//   1. CRDT path (authoritative, cross-peer): watches the folder Y.Doc's
//      `deletedComponentIds` array via the FolderTokensSnapshot. Every
//      client that has the folder doc open (i.e. every editor in this
//      folder) reacts when a peer writes the deletion signal, regardless
//      of whether they also received the window event.
//
//   2. Window event path (fast-path, same-tab only): the originating
//      client sees the deletion synchronously before the CRDT observer
//      round-trip. Kept so the editor that performed the delete feels
//      instant.
//
// Idempotency: removeComponentInstancesFromDoc is safe to call twice for
// the same componentId — the second pass finds no matching objects and
// is a no-op, so both paths firing on the same client is harmless.
// ---------------------------------------------------------------------------

function ComponentDeleteCascadeEffect() {
  const { deckCtx } = useSlideDoc()
  const folderTokens = useFolderTokensOptional()
  // Track which componentIds we have already swept so the CRDT observer
  // doesn't re-sweep on every unrelated folder doc change.
  const sweptRef = useRef<Set<string>>(new Set())

  // CRDT path — react to the folder Y.Doc's deletedComponentIds array.
  useEffect(() => {
    if (folderTokens === null || deckCtx === null) return
    const deletedIds = folderTokens.deletedComponentIds
    deletedIds.forEach((componentId) => {
      if (sweptRef.current.has(componentId)) return
      sweptRef.current.add(componentId)
      removeComponentInstancesFromDoc(deckCtx, componentId)
    })
  }, [folderTokens, deckCtx])

  // Window event path — fast-path for the originating client.
  useEffect(() => {
    function handler(e: Event) {
      const componentId = (e as CustomEvent<{ componentId: string }>).detail?.componentId
      if (typeof componentId !== 'string' || componentId === '') return
      if (deckCtx === null) return
      // Mark as swept so the CRDT observer doesn't duplicate the work.
      sweptRef.current.add(componentId)
      removeComponentInstancesFromDoc(deckCtx, componentId)
    }
    window.addEventListener('narrative:component-deleted', handler)
    return () => {
      window.removeEventListener('narrative:component-deleted', handler)
    }
  }, [deckCtx])

  return null
}

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
                    <CanvasInstanceContext.Provider value={canvasInstance}>
                      {/* Propagates folder text-style token edits onto
                        every linked TextObject in this deck, skipping
                        per-object override fields. */}
                      <TextStylePropagator />
                      {/* Removes ComponentInstance objects from the open deck
                        when their master is deleted from the folder. */}
                      <ComponentDeleteCascadeEffect />
                      <Outlet
                        context={
                          { onCanvasReady: handleCanvasReady } satisfies DeckShellContextValue
                        }
                      />
                    </CanvasInstanceContext.Provider>
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

/**
 * components/FolderTokensBridge.tsx
 *
 * Gives a canvas subtree its folder's design tokens: the synchronous
 * `TokensProvider` resolver for React consumers, and the same resolver
 * installed into the Pixi renderer (renderer/colourResolver.ts), which cannot
 * call hooks.
 *
 * Must sit inside `<FolderDocProvider>`. Every surface that mounts a Pixi
 * canvas over a folder's content uses it — DeckShell (editor + present) and
 * the component master editor — so a token-linked colour paints the same in
 * all of them.
 */

import { useEffect } from 'react'
import { useFolderTokens } from '../state/FolderDocProvider.js'
import { TokensProvider, useTokensResolve } from '../state/TokensContext.js'
import { setColourResolver } from '../renderer/colourResolver.js'
import { useDeckVariant } from '../state/useDeckMeta.js'

/**
 * Reads the live token snapshot from FolderDocProvider and passes it to
 * TokensProvider. Separate component so it sits inside FolderDocProvider.
 */
export function FolderTokensBridge({
  children,
  variant,
  installResolver = true,
}: {
  children: React.ReactNode
  /** The deck's variant (A4.2d); absent outside a deck. */
  variant?: Readonly<Record<string, string>> | undefined
  /**
   * False where a nested `DeckTokensBridge` installs the resolver with the
   * deck's variant (DeckShell): two installers would fight.
   */
  installResolver?: boolean
}) {
  const tokens = useFolderTokens()
  return (
    <TokensProvider tokens={tokens} variant={variant}>
      {installResolver && <ColourResolverInstaller />}
      {children}
    </TokensProvider>
  )
}

/**
 * The folder bridge again, inside the deck's `SlideDocProvider`, with the
 * deck's variant (A4.2d): colour tokens that differ per variant resolve on
 * the deck's, in React and in the renderer.
 */
export function DeckTokensBridge({ children }: { children: React.ReactNode }) {
  const variant = useDeckVariant()
  return <FolderTokensBridge variant={variant}>{children}</FolderTokensBridge>
}

/**
 * Installs the React-side token colour resolver into the renderer's
 * module-level slot so the Pixi object renderers can call resolveColour()
 * synchronously. The resolver changes with every token snapshot (the
 * placeholder, the synced folder document, each live token edit); the
 * renderer repaints what the change affects (colourResolver.ts, Lifecycle).
 *
 * Replacing the resolver and uninstalling it are separate effects on
 * purpose: one effect with a cleanup would install `null` between every two
 * snapshots, and each install is a repaint of the token-coloured objects.
 */
function ColourResolverInstaller() {
  const resolve = useTokensResolve()
  useEffect(() => {
    setColourResolver(resolve)
  }, [resolve])
  useEffect(() => {
    return () => {
      setColourResolver(null)
    }
  }, [])
  return null
}

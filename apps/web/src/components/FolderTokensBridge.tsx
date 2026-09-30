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

/**
 * Reads the live token snapshot from FolderDocProvider and passes it to
 * TokensProvider. Separate component so it sits inside FolderDocProvider.
 */
export function FolderTokensBridge({ children }: { children: React.ReactNode }) {
  const tokens = useFolderTokens()
  return (
    <TokensProvider tokens={tokens}>
      <ColourResolverInstaller />
      {children}
    </TokensProvider>
  )
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

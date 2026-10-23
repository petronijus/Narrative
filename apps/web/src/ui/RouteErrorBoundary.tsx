/**
 * ui/RouteErrorBoundary.tsx
 *
 * Catches what the routes throw, so a failure shows a message instead of a
 * blank page. Before it existed, a lazy page whose chunk failed to download
 * (`net::ERR_NETWORK_CHANGED`, a deploy that replaced the chunk) made React
 * unmount the whole tree and the page stayed white.
 *
 * - A route load failure (`RouteLoadError`, see `lazyRoute.tsx`; it arrives
 *   only after the page's first load retried once by itself) first asks
 *   the version guard whether a deploy happened. If the server serves a newer
 *   build, the page reloads once — `checkForNewBuild` remembers the version
 *   it reloaded for in sessionStorage, so a stale document pinned by a proxy
 *   cannot loop. Otherwise the fallback offers Retry (re-attempt the import)
 *   and Reload.
 * - Any other render error gets the same card with generic wording; Retry
 *   re-renders the routes.
 * - Navigating to another path clears the error (`resetKey`).
 *
 * The one class component in the UI: React has no hook for error boundaries.
 */

import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { checkForNewBuild } from '../state/versionGuard.js'
import { isRouteLoadError, resetFailedRoutes } from './lazyRoute.js'

/** How long the deploy check may take before the fallback shows anyway. */
const VERSION_CHECK_TIMEOUT_MS = 5_000

/** Centred spinner shown while a lazy route loads (and while a deploy is checked). */
export function RouteSpinner({ label }: { label: string }) {
  return (
    <div
      className="flex h-screen w-screen items-center justify-center"
      role="status"
      aria-label={label}
    >
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-blue-400" />
    </div>
  )
}

interface RouteErrorFallbackProps {
  loadFailed: boolean
  retried: boolean
  onRetry: () => void
}

function RouteErrorFallback({ loadFailed, retried, onRetry }: RouteErrorFallbackProps) {
  const primaryRef = useRef<HTMLButtonElement>(null)
  // Focus the suggested action: keyboard users land on the way out.
  useEffect(() => {
    primaryRef.current?.focus()
  }, [retried])

  const title = loadFailed ? 'This page couldn’t load' : 'Something went wrong'
  const detail = retried
    ? 'Retrying didn’t help. Reloading the page usually does.'
    : loadFailed
      ? 'Part of Narrative didn’t download — the connection may have dropped, or a new version was just released.'
      : 'This page hit an unexpected error.'
  // After a failed retry, Reload is the action that works: make it primary.
  const reloadFirst = retried

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div
        role="alert"
        aria-labelledby="route-error-title"
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm"
      >
        <h1 id="route-error-title" className="mb-2 text-base font-semibold">
          {title}
        </h1>
        <p className="mb-5 text-sm text-muted-foreground">{detail}</p>
        <div className="flex justify-end gap-2">
          <Button
            ref={reloadFirst ? undefined : primaryRef}
            variant={reloadFirst ? 'outline' : 'default'}
            onClick={onRetry}
          >
            Retry
          </Button>
          <Button
            ref={reloadFirst ? primaryRef : undefined}
            variant={reloadFirst ? 'default' : 'outline'}
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        </div>
      </div>
    </div>
  )
}

interface BoundaryProps {
  /** Changing it clears a caught error (the current path). */
  resetKey: string
  children: ReactNode
}

interface BoundaryState {
  error: unknown
  hasError: boolean
  /** A route load failed and the deploy check is still running. */
  checkingForDeploy: boolean
  /** The user already pressed Retry since the last navigation. */
  retried: boolean
  resetKey: string
}

class RouteErrorBoundaryInner extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = {
    error: null,
    hasError: false,
    checkingForDeploy: false,
    retried: false,
    resetKey: this.props.resetKey,
  }

  /** Bumped on every reset, so a deploy check that outlives its error is ignored. */
  private epoch = 0

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error, hasError: true, checkingForDeploy: isRouteLoadError(error) }
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    if (props.resetKey === state.resetKey) return null
    return {
      resetKey: props.resetKey,
      error: null,
      hasError: false,
      checkingForDeploy: false,
      retried: false,
    }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[RouteErrorBoundary] route failed', error, info.componentStack)
    if (isRouteLoadError(error)) void this.checkForDeploy()
  }

  override componentDidUpdate(prevProps: BoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey) this.epoch += 1
  }

  private async checkForDeploy(): Promise<void> {
    const epoch = this.epoch
    // A new build on the server explains a missing chunk: reload once to run
    // it. `null` = no newer build, the check failed, or this tab already
    // reloaded for that version — show the fallback.
    const reloadingFor = await checkForNewBuild(AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS))
    if (reloadingFor !== null || epoch !== this.epoch) return
    this.setState({ checkingForDeploy: false })
  }

  private readonly retry = (): void => {
    this.epoch += 1
    resetFailedRoutes()
    this.setState({ error: null, hasError: false, checkingForDeploy: false, retried: true })
  }

  override render(): ReactNode {
    const { hasError, error, checkingForDeploy, retried } = this.state
    if (!hasError) return this.props.children
    if (checkingForDeploy) return <RouteSpinner label="Loading" />
    return (
      <RouteErrorFallback
        loadFailed={isRouteLoadError(error)}
        retried={retried}
        onRetry={this.retry}
      />
    )
  }
}

/** The error boundary around the routes; must render inside the router. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return <RouteErrorBoundaryInner resetKey={pathname}>{children}</RouteErrorBoundaryInner>
}

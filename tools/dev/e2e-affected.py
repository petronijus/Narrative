#!/usr/bin/env python3
"""The Playwright specs a change needs: `just e2e-affected [--base REF] [--list]`.

Reads the changed files — against REF (default HEAD: the working tree,
staged and untracked files included) — and maps them to e2e specs with the
AREAS table below, the machine-readable form of AGENTS.md → "When to run
what". Then it runs those specs through `just e2e` (or, with --list, only
prints them).

  - A changed spec runs itself; a changed e2e fixture runs every spec.
  - A shared package, the database schema or an app's entry point runs the
    whole suite. So does a source file no area claims, and it is named so
    the table can learn it: missing a spec is worse than a longer run.
  - Unit tests, test support, docs, tooling and migrations need no e2e run
    (NO_E2E); other files outside the apps' and packages' sources neither.

Globs use fnmatch: `*` also crosses `/`.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC_DIR = ROOT / "apps" / "web" / "e2e"

# The app boots and works at all: the API, the editor painting its canvas,
# text, present mode and an anonymous share-link visit — ~10 s in parallel.
# For changes that can only break that (the page shell, static files,
# styles), and as `just e2e-smoke`.
SMOKE = [
    "destructive-flows",
    "share-link-folder-tokens",
    "text-overflow-clip",
    "present-layout",
    "fit-to-screen",
]

RENDER = [
    "renderer-visual",
    "render-page",
    "render-export",
    "inspector-flows",
    "canvas-sharpness-final",
    "htmltext-live-update",
    "htmltext-texture-isolation",
    "text-glyph-overhang",
    "text-overflow-clip",
    "thumbnails-after-slide-switch",
    "folder-tokens",
    "share-link-folder-tokens",
]
TEXT = [
    "text-edit-commands",
    "text-edit-position",
    "text-edit-screenshots",
    "text-edit-underline",
    "text-edit-undo",
    "text-edit-wrap",
    "text-line-height-run-size",
    "text-line-spacing-fidelity",
    "text-reload-invisible",
    "typography-commands",
    "list-feature-smoke",
]
SLIDES_PANEL = [
    "slides-panel-drag",
    "slide-clipboard",
    "slide-duplicate",
    "slide-multi-select",
    "sidebar-holds-position",
    "thumbnail-drag-repro",
    "thumbnails-after-slide-switch",
]
SYNC = [
    "multi-client-collab",
    "multi-window-slide-sync",
    "sync-after-slide-switch",
    "share-link-folder-tokens",
]
ACCESS = [
    "destructive-flows",
    "share-link-folder-tokens",
    "access-tokens",
    "move-deck-share-link",
    "folder-sharing",
]
TOKENS = ["folder-tokens", "share-link-folder-tokens", "folder-font-preview"]
COMPONENTS = [
    "component-master-upload",
    "component-picker-search-settings",
    "component-promote-stamp",
    "m16-component-flows",
]
MEDIA = ["image-upload", "component-master-upload", "upload-crash-repro", "agent-upload-session"]
PPTX = ["pptx-drop-import", "pptx-drop-into-panel", "pptx-import-fidelity", "pptx-roundtrip"]
AGENT = ["agent-activity", "agent-confirm", "agent-upload-session", "mcp-oauth-consent"]
PRESENT = ["present-layout", "slide-transition", "animation-commands"]
INSPECTOR = [
    "inspector-flows",
    "inspector-appearance-commands",
    "fill-mode-switch",
    "typography-commands",
    "layer-reorder",
]
CANVAS_TOOLS = [
    "guides",
    "path-editing",
    "fit-to-screen",
    "zoom-text-probe",
    "object-clipboard",
    "object-context-menu",
    "layer-reorder",
]

# (glob, specs). Every matching row counts; order does not matter.
AREAS: list[tuple[str, list[str]]] = [
    # ── web: the page shell, static files, styles ─────────────────────────
    ("apps/web/index.html", SMOKE),
    ("apps/web/public/*", SMOKE),
    ("apps/web/src/index.css", SMOKE),
    ("apps/web/src/styles/*", SMOKE),
    # ── web: renderer and canvas ──────────────────────────────────────────
    ("apps/web/src/renderer/playTransition*", PRESENT),
    ("apps/web/src/renderer/*", RENDER),
    ("apps/web/src/components/FolderTokensBridge.tsx", RENDER),
    ("apps/web/src/components/PresentLayout.tsx", PRESENT),
    ("apps/web/src/components/presentStartSlide.ts", PRESENT),
    ("apps/web/src/pages/DeckPresent.tsx", PRESENT),
    # render-export reaches __narrativeRenderShow (the worker's slide switch).
    ("apps/web/src/pages/DeckRender.tsx", ["render-page", "render-export", "query-render"]),
    ("apps/web/src/pages/renderLook.ts", ["query-render"]),
    ("apps/web/src/pages/renderSlide.ts", ["render-page"]),
    # The toolbar's PowerPoint download goes through it too.
    ("apps/web/src/lib/download.ts", ["render-export", "pptx-roundtrip"] + SLIDES_PANEL),
    # The editor's in-browser "Export as PNG" (a hidden frame on the render page).
    ("apps/web/src/state/browserSlideExport.ts", ["render-export", "render-page"]),
    ("apps/web/src/lib/stateVector.ts", ["render-export"]),
    ("apps/web/src/lib/endpoints.ts", SMOKE + SYNC + ["render-page"]),
    ("apps/web/src/lib/shareToken.ts", ACCESS + TOKENS + MEDIA + ["render-page"]),
    ("apps/web/src/ui/PresenterOverlay.tsx", PRESENT),
    ("apps/web/src/components/EditorLayout.tsx", RENDER + CANVAS_TOOLS + ["keyboard-shortcuts"]),
    ("apps/web/src/components/DeckShell.tsx", RENDER + SYNC),
    ("apps/web/src/pages/DeckEditor.tsx", RENDER + SYNC),
    ("apps/web/src/editor/*", CANVAS_TOOLS + ["keyboard-shortcuts"]),
    ("apps/web/src/ui/TransformHandles.tsx", CANVAS_TOOLS),
    ("apps/web/src/ui/SnapGuides.tsx", ["guides"]),
    ("apps/web/src/ui/Rulers.tsx", ["guides"]),
    ("apps/web/src/ui/PathPointsOverlay.tsx", ["path-editing"]),
    ("apps/web/src/ui/LineEndpointHandles.tsx", ["path-editing"]),
    ("apps/web/src/ui/ZoomControl.tsx", ["fit-to-screen", "zoom-text-probe"]),
    ("apps/web/src/ui/EditorContextMenu.tsx", ["object-context-menu"]),
    # Cut, shared by the context menu and the Mod+X shortcut.
    ("apps/web/src/state/cutSelection.ts", ["object-context-menu", "keyboard-shortcuts"]),
    ("apps/web/src/ui/CropOverlay.tsx", MEDIA + ["fill-mode-switch"]),
    ("apps/web/src/ui/Table*", ["table-commands"]),
    ("apps/web/src/ui/TextEditOverlay.tsx", TEXT),
    ("apps/web/src/ui/textEditDom.ts", TEXT),
    ("apps/web/src/ui/Font*", TEXT + ["folder-font-preview"]),
    ("apps/web/src/ui/SlideNotesPanel.tsx", ["text-edit-commands"]),
    ("apps/web/src/ui/Inspector.tsx", INSPECTOR),
    ("apps/web/src/ui/ColorInput.tsx", INSPECTOR + TOKENS),
    ("apps/web/src/ui/TokenColorInput.tsx", INSPECTOR + TOKENS),
    ("apps/web/src/ui/StageBgPicker.tsx", INSPECTOR),
    ("apps/web/src/ui/AlignButtonGroup.tsx", INSPECTOR),
    ("apps/web/src/ui/AnimationTimeline.tsx", PRESENT),
    ("apps/web/src/ui/animationTriggers.ts", PRESENT),
    ("apps/web/src/ui/Slide*", SLIDES_PANEL),
    ("apps/web/src/ui/Toolbar.tsx", CANVAS_TOOLS + ["keyboard-shortcuts"]),
    ("apps/web/src/ui/ShortcutsCheatsheet.tsx", ["keyboard-shortcuts"]),
    ("apps/web/src/ui/*Component*", COMPONENTS),
    ("apps/web/src/ui/Upload*", MEDIA),
    ("apps/web/src/ui/Video*", MEDIA),
    ("apps/web/src/ui/EditorVideoPreview.tsx", MEDIA),
    ("apps/web/src/ui/*Pptx*", PPTX),
    ("apps/web/src/ui/ShareDialog.tsx", ACCESS),
    ("apps/web/src/ui/FolderShareDialog.tsx", ACCESS),
    ("apps/web/src/ui/sharing/*", ACCESS),
    ("apps/web/src/ui/MoveDeckModal.tsx", ACCESS),
    ("apps/web/src/ui/NewDeckDialog.tsx", ACCESS),
    ("apps/web/src/ui/AgentActivityPopover.tsx", AGENT),
    ("apps/web/src/ui/agentActivity.ts", AGENT),
    ("apps/web/src/ui/EditorShowOverlay.tsx", AGENT),
    ("apps/web/src/ui/EditorNotice.tsx", AGENT),
    ("apps/web/src/ui/Peer*", SYNC),
    ("apps/web/src/ui/peerPresence.ts", SYNC),
    ("apps/web/src/ui/AvatarChips.tsx", SYNC),
    ("apps/web/src/ui/LockBadges.tsx", CANVAS_TOOLS),
    ("apps/web/src/ui/MoveToTargetOverlay.tsx", SLIDES_PANEL),
    ("apps/web/src/ui/OverlayScrollbars.tsx", ["fit-to-screen"]),
    ("apps/web/src/ui/ResizableSidebar.tsx", ["sidebar-holds-position"]),
    ("apps/web/src/ui/PerfHud*", ["idle-cpu-measurement"]),
    ("apps/web/src/ui/VersionChip.tsx", []),
    # Around every route: a broken boundary or lazy wrapper blanks the app.
    ("apps/web/src/ui/RouteErrorBoundary.tsx", SMOKE + ["route-load-failure"]),
    ("apps/web/src/ui/lazyRoute.tsx", SMOKE + ["route-load-failure"]),
    ("apps/web/src/ui/ThemeToggle.tsx", []),
    ("apps/web/src/ui/UserMenu.tsx", ACCESS),
    ("apps/web/src/ui/handleVisuals.tsx", CANVAS_TOOLS),
    ("apps/web/src/ui/commandPatch.ts", INSPECTOR),
    ("apps/web/src/components/ui/*", ["object-context-menu", "keyboard-shortcuts"]),
    ("apps/web/src/actions/*", ["keyboard-shortcuts", "object-context-menu"]),
    # ── web: state ────────────────────────────────────────────────────────
    ("apps/web/src/state/useShortcuts.ts", ["keyboard-shortcuts"]),
    # Every pointer gesture's undo step: the drags and the menus.
    (
        "apps/web/src/state/undoGestures.ts",
        CANVAS_TOOLS + INSPECTOR + SLIDES_PANEL + ["table-commands", "keyboard-shortcuts"],
    ),
    ("apps/web/src/state/FolderDoc*", TOKENS),
    ("apps/web/src/state/TokensContext.tsx", TOKENS + RENDER),
    ("apps/web/src/state/folderTokenWriter.ts", TOKENS),
    ("apps/web/src/state/FolderFontLoader.ts", ["folder-font-preview", "render-export"]),
    ("apps/web/src/state/useFolderFonts.tsx", ["folder-font-preview"]),
    ("apps/web/src/state/useDeckFonts.tsx", ["folder-font-preview"]),
    ("apps/web/src/state/bundledFonts.ts", TEXT),
    ("apps/web/src/state/SlideDocProvider.tsx", SYNC + ["render-page"]),
    ("apps/web/src/state/slideDocContext.ts", SYNC + ["render-page"]),
    ("apps/web/src/state/hocuspocusAuth.ts", SYNC + TOKENS),
    ("apps/web/src/state/DeckRoleContext.tsx", ACCESS + TOKENS),
    ("apps/web/src/state/folderAccess.ts", ACCESS + COMPONENTS),
    ("apps/web/src/state/AuthContext.tsx", ACCESS),
    ("apps/web/src/state/useAwareness*", SYNC),
    ("apps/web/src/state/localAwarenessState.ts", SYNC),
    ("apps/web/src/state/agentPrincipal.ts", AGENT),
    ("apps/web/src/state/editorShow.ts", AGENT),
    ("apps/web/src/state/editorNotice.ts", AGENT),
    ("apps/web/src/state/*Component*", COMPONENTS),
    ("apps/web/src/state/componentDocCache.ts", COMPONENTS),
    ("apps/web/src/state/readMasterDoc.ts", COMPONENTS),
    ("apps/web/src/state/useStampComponent.ts", COMPONENTS),
    ("apps/web/src/state/promoteSelectionToComponent.ts", COMPONENTS),
    ("apps/web/src/state/useMedia*", MEDIA),
    ("apps/web/src/state/mediaCache.ts", MEDIA),
    ("apps/web/src/state/uploadMetadata.ts", MEDIA),
    ("apps/web/src/state/useVideoInfo.ts", MEDIA),
    ("apps/web/src/state/importPptxViaTus.ts", PPTX),
    ("apps/web/src/state/slideClipboard.ts", ["slide-clipboard"]),
    ("apps/web/src/state/clipboard.ts", ["object-clipboard", "slide-clipboard"]),
    ("apps/web/src/state/useObjectClipboard.ts", ["object-clipboard"]),
    ("apps/web/src/state/useSlideThumbnails.ts", SLIDES_PANEL + TOKENS),
    ("apps/web/src/state/thumbnailRetry.ts", SLIDES_PANEL + TOKENS),
    ("apps/web/src/state/deckThumbnailCache.ts", SLIDES_PANEL),
    ("apps/web/src/state/useSlides.ts", SLIDES_PANEL + SYNC),
    ("apps/web/src/state/useAnimations.ts", PRESENT),
    ("apps/web/src/state/TextEditContext.tsx", TEXT),
    ("apps/web/src/state/TableEditContext.tsx", ["table-commands"]),
    ("apps/web/src/state/PathPointsModeContext.tsx", ["path-editing"]),
    ("apps/web/src/state/CropModeContext.tsx", ["fill-mode-switch"]),
    ("apps/web/src/state/SnappingContext.tsx", ["guides"]),
    ("apps/web/src/state/RulersContext.tsx", ["guides"]),
    ("apps/web/src/state/useDeckGuides.ts", ["guides"]),
    ("apps/web/src/state/useZoomLevel.ts", ["fit-to-screen", "zoom-text-probe"]),
    ("apps/web/src/state/PerfHudContext.tsx", ["idle-cpu-measurement"]),
    ("apps/web/src/state/testApi*", ["*"]),
    ("apps/web/src/state/useCommand.ts", ["*"]),
    # ── web: pages ────────────────────────────────────────────────────────
    ("apps/web/src/pages/Folder*", ACCESS + TOKENS + ["folder-font-preview"]),
    # The folder page's notice after a deck move (FolderDecks.tsx).
    ("apps/web/src/pages/moveMediaNotice*", ACCESS),
    ("apps/web/src/pages/ComponentMasterEditor.tsx", COMPONENTS),
    ("apps/web/src/pages/AccessTokens.tsx", ["access-tokens"]),
    ("apps/web/src/pages/accessTokenList.ts", ["access-tokens"]),
    ("apps/web/src/pages/ConfirmAgentAction.tsx", ["agent-confirm", "mcp-oauth-consent"]),
    ("apps/web/src/pages/Auth*", ACCESS),
    ("apps/web/src/components/ProtectedRoute.tsx", ACCESS),
    ("apps/web/src/api/*", ACCESS + MEDIA + COMPONENTS + TOKENS),
    # ── server ────────────────────────────────────────────────────────────
    ("apps/server/src/hocuspocus/*", SYNC + ACCESS),
    ("apps/server/src/auth/*", ACCESS),
    ("apps/server/src/http/requestLogSerializer.ts", SMOKE),
    # Every request passes the rate limiter; the same-origin policy guards the
    # command API (every editor write) and the PNG route.
    ("apps/server/src/http/rateLimit.ts", ["*"]),
    ("apps/server/src/http/sameOrigin.ts", ["*"]),
    ("apps/server/src/routes/devRender.ts", ["render-page"]),
    ("apps/server/src/services/sharing.ts", ACCESS),
    ("apps/server/src/services/folderSharing.ts", ACCESS),
    ("apps/server/src/routes/folderSharing.ts", ACCESS),
    ("apps/server/src/email/*", ACCESS),
    ("apps/server/src/services/shared.ts", ACCESS + TOKENS + COMPONENTS),
    ("apps/server/src/services/folders.ts", ACCESS + ["folder-font-preview"]),
    ("apps/server/src/services/decks.ts", ACCESS + ["slide-duplicate"]),
    ("apps/server/src/routes/sharing.ts", ACCESS),
    ("apps/server/src/routes/folders.ts", ACCESS),
    ("apps/server/src/routes/decks.ts", ACCESS + SLIDES_PANEL),
    ("apps/server/src/services/tokens.ts", TOKENS),
    ("apps/server/src/services/tokenRebind.ts", TOKENS),
    ("apps/server/src/routes/tokens.ts", TOKENS),
    ("apps/server/src/services/component*", COMPONENTS),
    ("apps/server/src/routes/component*", COMPONENTS),
    ("apps/server/src/services/deckInsert.ts", COMPONENTS + ["slide-clipboard", "object-clipboard"]),
    ("apps/server/src/services/localiseMedia.ts", COMPONENTS + ACCESS),
    ("apps/server/src/routes/insertObjects.ts", COMPONENTS + ["object-clipboard"]),
    ("apps/server/src/media/*", MEDIA),
    ("apps/server/src/services/media*", MEDIA),
    ("apps/server/src/pptx/*", PPTX),
    ("apps/server/src/services/pptx.ts", PPTX),
    ("apps/server/src/routes/pptx*", PPTX),
    ("apps/server/src/mcp/*", AGENT),
    ("apps/server/src/agent/*", AGENT),
    # Agent runs and their revert (its after-revert hook copies old folder media).
    ("apps/server/src/services/runs.ts", AGENT + COMPONENTS),
    ("apps/server/src/routes/commands.ts", AGENT),
    # The service set every command and route is built from.
    ("apps/server/src/services/index.ts", AGENT + ACCESS),
    ("apps/video-worker/src/*", MEDIA),
    ("apps/render-worker/*", ["render-export", "render-page", "query-render"]),
    # The desktop shell (ADR 0014). Its Electron specs join with the shell's
    # Playwright project (D0 step 9); the web e2e suite does not load it.
    ("apps/desktop/*", []),
    # The bridge contract: types and constants the shell and the web app's
    # desktop module share; the editor does not import it otherwise.
    ("packages/shared/src/desktop.ts", []),
    # The editor's side of the bridge: inert in a browser (no
    # window.narrativeDesktop), so only the shell's own specs exercise it.
    ("apps/web/src/desktop/*", []),
    # Browser and desktop sign-in; the MCP OAuth pages share the page headers
    # and the strict form parser.
    ("apps/server/src/routes/auth.ts", ACCESS),
    ("apps/server/src/routes/desktopAuth.ts", ACCESS),
    ("apps/server/src/http/htmlHeaders.ts", AGENT),
    ("apps/server/src/http/formBody.ts", AGENT),
    # Error reporting runs only with SENTRY_DSN, which no e2e run sets; its
    # scrubbing is unit-tested.
    ("apps/server/src/observability/*", []),
    ("apps/server/src/services/render.ts", ["render-export", "query-render"]),
    ("apps/server/src/render/*", ["render-export", "query-render"]),
    ("apps/server/src/mcp/results.ts", ["query-render"]),
    ("apps/server/src/routes/pngExport.ts", ["render-export"]),
    # ── packages ──────────────────────────────────────────────────────────
    ("packages/animation/src/*", PRESENT),
    # The service interfaces are types only; their server implementations
    # are mapped above and typecheck covers the rest.
    ("packages/commands/src/services/*", []),
    # Everything reaches these: the whole suite, on purpose.
    ("packages/commands/src/*", ["*"]),
    ("packages/slide-model/src/*", ["*"]),
    ("packages/shared/src/*", ["*"]),
    ("apps/server/src/db/*", ["*"]),
    ("apps/server/src/index.ts", ["*"]),
    ("apps/server/src/http/registerRoutes.ts", ["*"]),
    ("apps/web/src/main.tsx", ["*"]),
    ("apps/web/src/App.tsx", ["*"]),
]

# Changes that never need an e2e run (checked before AREAS).
NO_E2E = [
    "*.test.ts",
    "*.test.tsx",
    "*.bench.ts",
    "*/test-support/*",
    "*/testing/*",
    "packages/commands/src/parity/*",
    "*.md",
    "docs/*",
    "tests/*",
    "tools/*",
    ".claude/*",
    "claude-plugin/*",
    "infra/*",
    "packages/commands/capabilities.json",
    "apps/server/drizzle/*",
]

SOURCE = ["apps/*/src/*", "packages/*/src/*", "apps/web/index.html", "apps/web/vite.config.ts"]


def git(*args: str) -> list[str]:
    out = subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return [line for line in out.splitlines() if line]


def changed_files(base: str) -> list[str]:
    files = set(git("diff", "--name-only", base))
    files |= set(git("diff", "--name-only", "--cached", base))
    files |= set(git("ls-files", "--others", "--exclude-standard"))
    return sorted(f for f in files if (ROOT / f).exists())


def matches(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, p) for p in patterns)


def affected(files: list[str]) -> tuple[set[str], list[str], list[str]]:
    """The specs to run; the files whose area is the whole suite; the source files no area claims."""
    specs: set[str] = set()
    whole: list[str] = []
    unclaimed: list[str] = []
    for f in files:
        if f.startswith("apps/web/e2e/"):
            if f.endswith(".spec.ts"):
                specs.add(Path(f).name.removesuffix(".spec.ts"))
            else:
                whole.append(f)  # a fixture or helper every spec may use
            continue
        if matches(f, NO_E2E):
            continue
        rows = [s for glob, s in AREAS if fnmatch.fnmatch(f, glob)]
        # A specific row with no specs (types only) overrides a catch-all one.
        if [] in rows:
            rows = [r for r in rows if "*" not in r]
        if rows:
            for row in rows:
                if "*" in row:
                    whole.append(f)
                specs.update(s for s in row if s != "*")
        elif matches(f, SOURCE):
            unclaimed.append(f)
    return specs, whole, unclaimed


def is_serial(spec: Path) -> bool:
    """Whether a spec runs in the `serial` project (it carries the `@serial` tag)."""
    return "@serial" in spec.read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="HEAD", help="compare against this ref (default HEAD)")
    parser.add_argument("--list", action="store_true", help="print the specs, run nothing")
    parser.add_argument(
        "--check", action="store_true", help="only verify the table names existing specs"
    )
    parser.add_argument(
        "--smoke", action="store_true", help="run the smoke set, whatever changed"
    )
    args, playwright_args = parser.parse_known_args()

    existing = {p.name.removesuffix(".spec.ts") for p in SPEC_DIR.glob("*.spec.ts")}
    named = {spec for _, row in AREAS for spec in row if spec != "*"} | set(SMOKE)
    unknown = sorted(named - existing)
    if unknown:
        print(
            "e2e-affected: AREAS in tools/dev/e2e-affected.py names specs that do not exist: "
            + ", ".join(unknown)
        )
        return 2
    if args.check:
        return 0

    if args.smoke:
        targets = [f"e2e/{spec}.spec.ts" for spec in SMOKE]
        print(f"e2e-affected: the smoke set ({len(targets)} specs)")
        if args.list:
            return 0
        sys.stdout.flush()
        os.execvp("just", ["just", "e2e", *targets, *playwright_args])

    files = changed_files(args.base)
    specs, whole, unclaimed = affected(files)

    if whole or unclaimed:
        print("e2e-affected: the whole suite, for")
        for f in whole:
            print(f"  {f}  (reaches every surface)")
        for f in unclaimed:
            print(f"  {f}  (no area claims it — add it to AREAS in tools/dev/e2e-affected.py)")
        targets: list[str] = []
    elif not specs:
        print(f"e2e-affected: {len(files)} changed file(s), none needs an e2e run.")
        return 0
    else:
        targets = [f"e2e/{s}.spec.ts" for s in sorted(specs)]
        print(f"e2e-affected: {len(targets)} spec(s) for {len(files)} changed file(s):")
        for t in targets:
            print(f"  {t}")

    if args.list:
        return 0
    # Playwright runs a project's dependencies in full, without the spec
    # filter: targeting only `@serial` specs (the `serial` project) would run
    # the whole parallel suite first. They have nothing to wait for alone.
    if targets and all(is_serial(SPEC_DIR / Path(t).name) for t in targets):
        playwright_args = ["--no-deps", *playwright_args]
    sys.stdout.flush()
    os.execvp("just", ["just", "e2e", *targets, *playwright_args])


if __name__ == "__main__":
    sys.exit(main())

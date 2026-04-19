/**
 * EditorLayout — 3-pane editor shell.
 *
 * M0: placeholder panes only, no PixiJS yet.
 * M1: Canvas pane will mount PixiJS renderer.
 * M7: Inspector pane will have transform controls.
 */
export function EditorLayout() {
  return (
    <div className="flex h-full w-full overflow-hidden bg-gray-950">
      {/* Left sidebar: slide panel */}
      <aside className="flex w-48 flex-shrink-0 flex-col border-r border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Slides
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-gray-600">No slides yet</p>
        </div>
      </aside>

      {/* Center: canvas area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-gray-800 bg-gray-900 px-4 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Canvas
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center bg-gray-950">
          {/* PixiJS canvas will mount here in M1 */}
          <p className="select-none text-sm text-gray-700">Canvas renderer — coming in M1</p>
        </div>
      </main>

      {/* Right sidebar: inspector panel */}
      <aside className="flex w-56 flex-shrink-0 flex-col border-l border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Inspector
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-gray-600">Nothing selected</p>
        </div>
      </aside>
    </div>
  )
}

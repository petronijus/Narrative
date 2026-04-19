/**
 * EditorLayout — 3-pane editor shell.
 *
 * M0: placeholder panes only, no PixiJS.
 * M1: Center pane mountuje PixiJS renderer přes <Canvas /> komponentu.
 * M7: Inspector pane bude mít transform controls.
 */

import { Canvas } from '../renderer/Canvas'
import { demoSlide } from '../data/demoSlide'

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
        {/*
          position: relative + overflow: hidden = clipping container pro absolutně
          pozicovaný canvas element. Canvas.tsx používá position: absolute; inset: 0.
        */}
        <div className="relative flex-1 overflow-hidden bg-gray-950">
          <Canvas slideData={demoSlide} />
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

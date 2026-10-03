// @vitest-environment node
/**
 * pixiDestroyLint.test.ts — the rule that keeps Pixi Application teardown in
 * renderer/pixiApplication.ts (apps/web/eslint.pixi-destroy.js): it must
 * catch an Application however it is held, and leave every other `destroy`
 * — textures, containers, the object renderers — alone.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import tsparser from '@typescript-eslint/parser'
import {
  PIXI_APPLICATION_MODULE,
  PIXI_DESTROY_PLUGIN,
  PIXI_DESTROY_RULES,
} from '../eslint.pixi-destroy.js'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

const linter = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: {
        parser: tsparser,
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
      },
      plugins: { 'narrative-pixi': PIXI_DESTROY_PLUGIN },
      rules: PIXI_DESTROY_RULES,
    },
  ],
})

/** The message ids the rule reports for `code`, in source order. */
async function reports(code: string): Promise<string[]> {
  const [result] = await linter.lintText(code, {
    filePath: resolve(repoRoot, 'apps/web/src/renderer/Probe.tsx'),
  })
  const messages = result?.messages ?? []
  const fatal = messages.find((m) => m.fatal === true)
  if (fatal) throw new Error(`parse error: ${fatal.message}`)
  return messages.map((m) => m.messageId ?? m.ruleId ?? '?')
}

const IMPORT = "import { Application } from 'pixi.js'\n"

describe('narrative-pixi/application-destroy', () => {
  it('catches an Application however it is held', async () => {
    const cases = [
      // constructed, with the page-wide release
      `${IMPORT}const app = new Application()\napp.destroy(true, { children: true })`,
      // typed, nullable, optional call
      `${IMPORT}let app: Application | null = null\nexport const f = () => app?.destroy()`,
      // assigned after the use that destroys it (judged at the end of the file)
      `${IMPORT}let app\nexport const stop = () => app.destroy()\napp = new Application()`,
      // a parameter, under an aliased import
      "import { Application as PixiApp } from 'pixi.js'\nexport function f(a: PixiApp) { a.destroy() }",
      // a type-only import and a namespace import
      "import type { Application } from 'pixi.js'\nexport function f(a: Application) { a.destroy() }",
      "import * as PIXI from 'pixi.js'\nexport function f(a: PIXI.Application) { a.destroy() }",
      // a React ref
      `${IMPORT}import { useRef } from 'react'\nexport function C() { const appRef = useRef<Application | null>(null); appRef.current?.destroy() }`,
      // a class field
      `${IMPORT}export class X { private app = new Application(); dispose() { this.app.destroy() } }`,
      `${IMPORT}export class X { app!: Application; dispose() { this.app!.destroy() } }`,
      // its renderer
      `${IMPORT}export function f(app: Application) { app.renderer.destroy() }`,
    ]
    for (const code of cases) {
      expect(await reports(code), code).toEqual(['applicationDestroy'])
    }
  })

  it('catches destroy(true) on something named like an Application or a renderer', async () => {
    for (const code of [
      'export function f(liveApp: any) { liveApp.destroy(true) }',
      'export function f(app: any) { app.destroy(true, { children: true }) }',
      'export function f(appRef: any) { appRef.current.destroy(true) }',
      'export function f(renderer: any) { renderer.destroy(true) }',
      'export function f(x: any) { x.renderer.destroy(true) }',
    ]) {
      expect(await reports(code), code).toEqual(['destroyTrue'])
    }
  })

  it('catches a releaseGlobalResources option wherever it goes', async () => {
    expect(
      await reports('export const f = (r: any) => r.destroy({ releaseGlobalResources: true })'),
    ).toEqual(['releaseGlobal'])
    expect(
      await reports(
        'export const f = (r: any, v: boolean) => r.destroy({ releaseGlobalResources: v })',
      ),
    ).toEqual(['releaseGlobal'])
  })

  it('leaves every other destroy alone', async () => {
    const code = `${IMPORT}
import { destroyPixiApplication } from './pixiApplication.js'
export function f(
  texture: any,
  entry: any,
  container: any,
  renderer: { destroy(node: unknown): void },
  thumbnails: { destroy(): void },
  node: unknown,
) {
  texture.destroy(true)
  entry.texture.destroy(true)
  container.destroy({ children: true })
  container.destroy(true)
  renderer.destroy(node)
  thumbnails.destroy()
  const app = new Application()
  destroyPixiApplication(app)
  texture.destroy({ releaseGlobalResources: false })
}
// another \`app\` in another scope is not the Application above
export function g(app: { destroy(): void }) { app.destroy() }
`
    expect(await reports(code)).toEqual([])
  })

  it('exempts only renderer/pixiApplication.ts', () => {
    expect(PIXI_APPLICATION_MODULE).toBe('apps/web/src/renderer/pixiApplication.ts')
  })
})

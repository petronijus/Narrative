/**
 * e2e/desktop.setup.ts — the `desktop-build` project: bundle the desktop
 * shell once before the `electron` project's specs run (fixtures/desktop.ts).
 */

import { test as setup } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { desktopDir } from './fixtures/desktop'

setup('bundle the desktop shell', () => {
  execFileSync(process.execPath, [path.join(desktopDir, 'scripts/build.mjs')], {
    cwd: desktopDir,
    stdio: 'inherit',
  })
})

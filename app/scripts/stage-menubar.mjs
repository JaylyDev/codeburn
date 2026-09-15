// Stage the Windows tray app into app/build/menubar so electron-builder ships it
// as extraResources. The counterpart of stage-cli.mjs, and it copies rather than
// downloads for the same reason: CI fetches the release assets in its own step
// and passes them with --from, and a developer points at a local build.
//
// Two layouts, because the two routes need different things:
//
//   --target nsis (default)
//     build/menubar/CodeBurn.Menubar_<version>_x64_en-US.msi
//     build/menubar/CodeBurn.Menubar_<version>_x64_en-US.msi.sha256
//
//     app/electron/menubar.ts hands that path to `codeburn menubar`, whose
//     Windows installer verifies the digest before msiexec sees the file. The
//     digest is copied when the source has one and computed when it does not, so
//     a local `cargo tauri build` stages the same shape a release does.
//
//   --target appx
//     build/menubar/codeburn-menubar.exe (plus anything beside it the app needs)
//
//     A packaged app cannot run msiexec, so the Store build launches the exe out
//     of its own package and the manifest's startup task covers launch at login.
//
// Sources, in order: --from <dir>, then the local Tauri build output.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // app/scripts
const appDir = join(here, '..')
const root = join(appDir, '..')
const stage = join(appDir, 'build', 'menubar')

// Tauri names the bundle after productName, so a local build is `CodeBurn Menubar_...`;
// GitHub rewrites that space to a dot on release upload, and the dot form is what the CLI
// installer, the Electron side and the tray's own updater all expect. Stage the dot form.
const MSI_PATTERN = /^CodeBurn[ .]Menubar_(.+)_x64_en-US\.msi$/
const TRAY_EXE = 'codeburn-menubar.exe'
/// What the Tauri build puts beside the exe and the app needs at runtime. Anything absent is
/// simply not copied: WebView2Loader ships only when the loader is not linked statically.
const TRAY_SIDECARS = ['WebView2Loader.dll']

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value) throw new Error(`${name} requires a value`)
  return value
}

const target = option('--target', 'nsis')
if (target !== 'nsis' && target !== 'appx') {
  throw new Error(`stage-menubar: --target must be nsis or appx, not ${target}`)
}

const defaultSource = target === 'nsis'
  ? join(root, 'windows', 'src-tauri', 'target', 'release', 'bundle', 'msi')
  : join(root, 'windows', 'src-tauri', 'target', 'release')
const source = option('--from', defaultSource)

function fail(message) {
  throw new Error(
    `stage-menubar: ${message}\n` +
    `  looked in ${source}\n` +
    '  build it with `cargo tauri build` in windows/, or pass --from <dir> with the\n' +
    '  downloaded windows-v* release assets.'
  )
}

// The stage is rebuilt from scratch every time: a leftover .msi from an older version would
// otherwise ship beside the current one and be found first.
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

if (!existsSync(source) || !statSync(source).isDirectory()) fail('no source directory')

if (target === 'nsis') {
  const msiName = readdirSync(source).find(name => MSI_PATTERN.test(name))
  if (!msiName) fail('no CodeBurn.Menubar_<version>_x64_en-US.msi')

  const stagedName = msiName.replace(' ', '.')
  const msiSource = join(source, msiName)
  copyFileSync(msiSource, join(stage, stagedName))

  // The release carries its own .sha256; a local build does not, and computing it here keeps
  // the installer's verification meaningful in both cases rather than skipped in one.
  const checksumSource = `${msiSource}.sha256`
  if (existsSync(checksumSource)) {
    copyFileSync(checksumSource, join(stage, `${stagedName}.sha256`))
  } else {
    const digest = createHash('sha256').update(readFileSync(msiSource)).digest('hex')
    writeFileSync(join(stage, `${stagedName}.sha256`), `${digest}  ${stagedName}\n`)
  }

  const version = MSI_PATTERN.exec(msiName)[1]
  const appVersion = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
  // A mismatch is not fatal: a desktop release can legitimately ship the newest tray build
  // there is. It is worth saying out loud, because it is usually a stale local bundle.
  if (version !== appVersion) {
    console.warn(`stage-menubar: staging tray app ${version} into desktop app ${appVersion}`)
  }
  console.log(`stage-menubar: staged ${stagedName} -> ${stage}`)
} else {
  const exeSource = join(source, TRAY_EXE)
  if (!existsSync(exeSource)) fail(`no ${TRAY_EXE}`)
  copyFileSync(exeSource, join(stage, TRAY_EXE))

  const copied = [basename(exeSource)]
  for (const sidecar of TRAY_SIDECARS) {
    const path = join(source, sidecar)
    if (!existsSync(path)) continue
    copyFileSync(path, join(stage, sidecar))
    copied.push(sidecar)
  }
  console.log(`stage-menubar: staged ${copied.join(', ')} -> ${stage}`)
}

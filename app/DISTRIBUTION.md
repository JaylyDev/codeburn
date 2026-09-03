# Distributing CodeBurn Desktop

This document describes how to produce distributable macOS, Windows, and Linux
builds of the Electron desktop app. The macOS build is ad-hoc-signed and
**not notarized** (no paid Apple Developer account); the Windows and Linux
builds are **unsigned**. Windows NSIS packages are built and checked by the
`Build Windows installer` GitHub Actions workflow; the other desktop packages
are still produced by hand. All three targets are produced by
`electron-builder`.

## The bundled CLI (no install prerequisite)

The packaged app ships its own copy of the `codeburn` CLI and needs nothing
installed on the target machine. Packaging stages a self-contained copy of the
root repo's CLI into `app/build/cli` (see `scripts/stage-cli.mjs`) — the tsup
bundle (`dist/main.js`), its Node-version launcher (`dist/cli.js`), the root
`package.json` (the bundle reads its `version`), plus the CLI's production
`node_modules` closure. An `afterPack` hook (`scripts/after-pack.cjs`) copies
that tree into the app at `Contents/Resources/cli/` after packaging and before
signing, so it lands inside the code signature.

At runtime a packaged build spawns the bundled CLI with Electron's own binary
acting as Node (`ELECTRON_RUN_AS_NODE=1`), so **no Node install is required** —
the app is version-matched to itself. `main.ts` sets `CODEBURN_BUNDLED_CLI` to
`Resources/cli/dist/launch.js` (a small shim that preserves the argument shape
expected by the resident and one-shot CLI paths, then hands off to `main.js`),
and `electron/cli.ts`
resolves it ahead of any persisted path or `PATH` lookup.

A user-installed CLI is only consulted **outside** a packaged build (dev via the
Vite dev server) or when explicitly overridden — `CODEBURN_BIN=/abs/path`, or a
persisted path file (`Application Support/CodeBurn/codeburn-cli-path.v1`). The
full resolution order in `electron/cli.ts` is: `CODEBURN_BIN` → dev repo CLI
(Vite) → bundled CLI → persisted path → `PATH`/Homebrew/nvm/volta/asdf.

### Freshness

Packaging **always rebuilds the root CLI** before staging: the app `stage-cli`
script runs the root `build:cli` (tsup only — no dashboard build, no network
`bundle-litellm` fetch), so `dist/main.js` and `dist/cli.js` are regenerated
from current `src/` on every `package*` run. A stale global `codeburn` can never
ship, and the app can never be older than the JSON surfaces it calls. The
bundled CLI's deps are pure JS (no native bindings), so the same staged tree is
valid for every arch.

### Why `afterPack`, not `extraResources`

electron-builder routes every `node_modules` directory it copies through its
production-dependency filter, which keeps only the *app's* own deps — so the
bundled CLI's dependency tree gets stripped out of an `extraResources` copy
(`filter: ["**/*"]` does not defeat this). `afterPack` copies the staged tree
in verbatim, which is the electron-builder-recommended mechanism for adding
unpacked files that must not be ASAR-archived.

## The bundled tray app and Capacity Dock (Windows only)

The Windows desktop app also carries the Tauri tray app from `windows/`, so
installing the desktop app gives the user the tray icon and the Capacity Dock
without their having to know that `codeburn menubar` exists. Two switches in the
sidebar's bottom-left corner turn each surface off ("Menu bar" is the tray
process, "Sidebar" is the dock rail); both default on, and neither appears on
macOS or Linux, or in a build with nothing staged.

`scripts/stage-menubar.mjs` puts the tray app into `app/build/menubar`, which
`build.win.extraResources` ships as `resources/menubar`. It copies rather than
downloads, exactly like `stage-cli.mjs`: with no `--from` it takes the local
`windows/src-tauri/target/release` output, and CI downloads the `windows-v*`
release assets in its own step and passes `--from <dir>`.

The two routes need different things staged, which is why there are two scripts:

- `npm run stage-menubar` (run by `package:win`) stages
  `CodeBurn.Menubar_<version>_x64_en-US.msi` and its `.sha256`. The digest is
  copied from the release when it is there and computed when it is not, so a
  local `cargo tauri build` stages the same shape a release does.
- `npm run stage-menubar:store` (run by `package:store`) stages
  `codeburn-menubar.exe` itself, plus any sidecar DLL beside it.

**The staged tray app is not the released one, even at the same version.**
`build-windows-installer.yml` runs `npm run tauri build` itself and stages the
MSI that run produced. `release-menubar-windows.yml` runs its own
`npm run tauri build` on a `windows-v*` tag and uploads that MSI as the release
asset. Two builds, two binaries: a Tauri MSI is not byte-reproducible (build
timestamps, the package GUID and the PDB signature differ per run), so the
`CodeBurn.Menubar_<version>_x64_en-US.msi` inside a desktop installer and the
`windows-v<version>` release asset of the same name are different files with
different `.sha256` digests, even off the same commit.

Nothing in the install path depends on them matching: the CLI's installer
verifies the digest of the file it was handed, and the upgrade rules go by the
`DisplayVersion` in the uninstall registry rather than by a hash. What it does
mean is that a version number is not a statement about which binary is on a
machine, and the release asset is not a way to reproduce or verify what a
desktop installer carries. So cut both from one commit when releasing, and say
"built by the desktop installer" or "the windows-v asset" rather than treating
the version as an identifier for either.

### The NSIS route: install through the CLI, never downgrade

`app/electron/menubar.ts` runs at every launch (which is also what covers a
desktop-app update, since the staged MSI travels with the app) and hands the
staged file to the CLI's own Windows installer by setting `CODEBURN_MENUBAR_MSI`
on a `codeburn menubar` spawn. The install itself is not reimplemented on the
Electron side: `src/menubar-installer.ts` owns the uninstall-registry read, the
checksum verification, the `msiexec /i ... /passive /norestart` call and the
rules that go with a bundled copy. It prints one `CODEBURN_MENUBAR_RESULT <json>`
line that the desktop app reads.

The spawn itself is not made at every launch. `msiexec /passive` puts an admin
prompt in front of the user, so `companion.v1.json` records the version of the
tray app that is on disk and the version of any staged MSI whose install was
declined (exit 1602) or failed. A launch skips the probe when the recorded tray
app is the staged version and is still there, and skips it when this exact
staged version was already refused. A newer staged version is always offered,
and so is turning the "Menu bar" switch on by hand, which clears the refusal.

Two of those rules matter here:

- **Deduplication.** The MSI carries a fixed WiX upgrade code
  (`windows/src-tauri/tauri.conf.json`, `bundle.windows.wix.upgradeCode`), which
  is the value Tauri already derived from the product name, so installing the
  bundled copy over a manual `codeburn menubar` install is an in-place upgrade
  rather than a second entry in Programs and Features.
- **Never downgrade.** If the installed `DisplayVersion` is newer than the
  bundled one, nothing is installed and the existing app is left alone.

**The marker.** The installer writes
`%LOCALAPPDATA%\codeburn-menubar\installed-by.json`, crediting `desktop` only
when it installed onto a machine that had no tray app, and `manual` when it
upgraded one that was already there. An existing marker's verdict is never
rewritten. `build/installer.nsh` (wired as `nsis.include`) reads it in the
uninstaller and removes the tray app only when the marker says `desktop`, so a
tray app the user installed by hand survives an uninstall of the desktop app.

Launch at login on this route is a single `HKCU\...\CurrentVersion\Run` value
named `CodeBurn`, the same value the tray app's own settings toggle writes
(`windows/src-tauri/src/autostart.rs`), so the two can never leave two entries.

### The Store route: no msiexec

A packaged app cannot run `msiexec` and would be fighting the package manager if
it could, so the AppX build ships `codeburn-menubar.exe` inside the package and
launches it from `app\resources\menubar\`. Launch at login is a
`windows.startupTask` extension (`build/appx-extensions.xml`, wired as
`appx.customExtensionsPath`), which also lets the user turn it off in
**Settings > Apps > Startup**; no Run value is written. The tray app detects the
package with `GetCurrentPackageFullName` and skips its own update checker
entirely, since Store updates cover it.

The startup task is Windows' to set, not this app's: reaching one would take the
WinRT `Windows.ApplicationModel.StartupTask` API, which Electron has no binding
for and which this app ships no native code to reach, and a Run value written
beside it would start the tray app twice. So `trayPrefs()` reports
`launchAtLoginManaged: true` on this route and the Menu bar pane renders that row
as text plus a button that opens `ms-settings:startupapps`, rather than a switch
that would silently move nothing. That URL is the one exception in the main
process's external-open guard, which is otherwise http(s) only.

### Talking to a running tray app

The tray app has no window of its own, so its argv is the control channel: the
Tauri single-instance plugin hands a running instance whatever a second launch
was started with (`windows/src-tauri/src/lib.rs`). `--quit` exits and
`--reload-settings` re-reads the preference files. Turning "Sidebar" off writes
`enabled: false` into `~/.config/codeburn/windows-dock.json` and then sends
`--reload-settings`, so a running rail disappears at once rather than at the next
launch.

## Versioning

`app/package.json`'s `version` tracks the CLI's version (root
`package.json`) — one CodeBurn version across CLI, menubar, and desktop.
Bump it in the same change that bumps the root version; the splash, the
About dialog, and the artifact filenames all read it from there.

## Build

```sh
npm --prefix app install
npm --prefix app run package          # macOS, both arm64 and x64
npm --prefix app run package:arm64    # macOS arm64 only (faster on Apple Silicon)
npm --prefix app run package:x64      # macOS x64 only
npm --prefix app run package:win      # Windows NSIS installer, x64
npm --prefix app run package:store    # Microsoft Store AppX, x64 (Windows host only)
npm --prefix app run package:linux    # Linux AppImage, x64
```

The Linux targets and arches can be widened by calling `electron-builder`
directly, all from the same macOS host:

```sh
cd app
npx electron-builder --linux AppImage deb        # x64 AppImage + deb
npx electron-builder --linux AppImage deb --x64  # force x64 on an arm64 mac
npx electron-builder --linux AppImage deb --arm64
npx electron-builder --linux rpm --x64           # rpm; needs `brew install rpm` (rpmbuild)
```

The `rpm` target is the only one with an extra prerequisite — `fpm` (bundled by
electron-builder) shells out to `rpmbuild`, so `brew install rpm` must be present
or the build fails with "executable rpmbuild is required". It emits
`codeburn-desktop-<version>.x86_64.rpm`, the name the website's Fedora/RHEL
download links.

`package` runs `npm run stage-cli` (rebuilds the root CLI and stages the
self-contained bundle into `app/build/cli`; see "The bundled CLI" above), then
`npm run build` (compiles `electron/` with `tsc`, builds the renderer with
`vite`), then `electron-builder --mac` (whose `afterPack` hook copies the
staged CLI into the app). `package:win` and `package:linux` mirror it exactly,
swapping the final flag for `electron-builder --win` and `electron-builder
--linux`. Developers can run all three locally on the same macOS host —
electron-builder downloads the NSIS and AppImage tooling on first use. Release
Windows installers are built by the `windows-latest` workflow described below.

### Artifacts

electron-builder writes to `app/release/` (gitignored, like `dist/`):

- `CodeBurn-<version>-arm64.dmg`, `CodeBurn-<version>.dmg` — installer images
- `CodeBurn-<version>-arm64-mac.zip`, `CodeBurn-<version>-mac.zip` — zipped `.app` bundles
- `release/mac-arm64/CodeBurn.app`, `release/mac/CodeBurn.app` — the raw unpacked bundles (arm64 and x64 respectively)
- `.blockmap` files alongside each zip/dmg (used by electron-builder's differential-update mechanism; unused since this app has no auto-updater yet)

Both `dmg` and `zip` targets are built for both `arm64` and `x64` — four
artifacts total, not a universal binary. This keeps each download roughly
half the size of a universal build. Pick the zip if you just want to unpack
and drag to `/Applications`; the dmg gives users the familiar drag-to-Applications
installer window.

### Build configuration

The `build` block lives in `app/package.json` (small enough not to warrant a
separate `electron-builder.yml`):

- `appId: "org.agentseal.codeburn-desktop"` — reuses the `org.agentseal.*`
  prefix from the menubar app's bundle id (`org.agentseal.codeburn-menubar`,
  see `mac/Scripts/package-app.sh`); there is no `com.codeburn.*` bundle id
  anywhere in the codebase, so `org.agentseal.*` is the actual house
  convention.
- `productName: "CodeBurn"`.
- `files`: only `dist/electron/**/*`, `dist/renderer/**/*`, and `package.json`.
  The Electron main process has no npm runtime dependencies (only Node/Electron
  builtins — see `app/electron/cli.ts` and `app/electron/quota/*.ts`), and the
  renderer is a single Vite bundle, so the app's own `node_modules` does not
  need to ship at all. (The *bundled CLI* has its own `node_modules`, added to
  `Resources/cli/` by the `afterPack` hook — see "The bundled CLI" above.)
- `afterPack: "./scripts/after-pack.cjs"` — copies the staged CLI bundle
  (`app/build/cli`) into `Contents/Resources/cli` after packaging and before
  signing.
- `mac.identity: "-"` — forces ad-hoc signing. **`identity: null` does NOT
  ad-hoc sign — it skips signing entirely**, which produces a bundle with a
  broken/absent seal (`codesign --verify --deep --strict` fails with
  `code has no resources but signature indicates they must be present`, and
  Apple Silicon refuses to run it at all). `"-"` is the same ad-hoc identity
  `mac/Scripts/package-app.sh` uses for the menubar app's local/CI builds.
- `mac.hardenedRuntime: false` — hardened runtime is for notarized builds;
  leaving it on for an ad-hoc signature with no entitlements can prevent the
  app from launching.
- `mac.gatekeeperAssess: false` — skips electron-builder's post-sign
  `spctl` check, which would always fail for an unnotarized app.
- `icon: build/icon.png` — a pre-existing 1024x1024 PNG at
  `app/build/icon.png`. No `.icns` exists in the repo; electron-builder
  generates one from the PNG at build time. This is the same source PNG
  used for the app icon; the menubar app has its own separate icon
  (`assets/menubar-logo.png`, converted to `.icns` in `package-app.sh`).
- `directories.output: "release"` — electron-builder's default output dir is
  `dist`, which collides with this app's existing `tsc`/`vite` build output
  (`app/dist/electron`, `app/dist/renderer`) that `files` reads from. Using
  a separate `release/` directory keeps build inputs and packaging outputs apart.

## Windows and Linux builds

Developers can cross-build both locally from the same macOS host used for the
mac build — no Windows or Linux machine, and no `wine`, is required.
Release-authoritative Windows NSIS installers are instead built by the `Build
Windows installer` workflow on `windows-latest`. electron-builder 26 embeds the
Windows executable's icon/version resources natively and downloads the NSIS and
AppImage tooling on first run.

### Windows (`package:win`)

`electron-builder --win` produces a single installer in `app/release/`:

- **`CodeBurn-Setup-0.9.15.exe`** — the NSIS installer (the version number
  tracks `package.json`). A `.exe.blockmap` is written alongside it
  (differential-update metadata, unused — no auto-updater yet).

Config (`build.win` + `build.nsis`):

- `win.target: nsis`, `arch: x64`.
- `win.icon: build/icon.png` — electron-builder converts the 1024x1024 PNG to
  a multi-resolution `.ico` at build time (same source PNG as the mac icon).
- `win.extraResources: build/menubar -> menubar`: the staged tray app (see
  "The bundled tray app and Capacity Dock" above). No `node_modules` is
  involved, so unlike the CLI this one can use `extraResources`.
- `nsis.include: build/installer.nsh`: the uninstall macro that removes the
  tray app only when the marker says the desktop app installed it.
- `nsis.oneClick: false` — an assisted installer with a wizard, so users get
  an **install-directory choice** instead of a silent one-click install.
- `nsis.perMachine: false` — installs per-user (into the user's `AppData`),
  so **no administrator/UAC elevation** is needed.

**The build is UNSIGNED** (no Authenticode certificate). electron-builder logs
`signing with signtool.exe`, but with no certificate configured that step is a
no-op — the `.exe` ships without a signature. On first run, Windows SmartScreen
shows **"Windows protected your PC"**. Users click **"More info" → "Run
anyway"** to launch it. This is expected for an unsigned build; the only fix is
a purchased code-signing (Authenticode/EV) certificate.

### Microsoft Store (`package:store`)

The Store build is a separate AppX target so the GitHub NSIS installer remains
unchanged. AppX packaging requires Windows 10 or newer and is built by the
manual `Build Windows Store package` GitHub Actions workflow on
`windows-latest`. Download its `CodeBurn-Microsoft-Store` workflow artifact and
upload the contained `CodeBurn-Store-<version>-x64.appx` file in Partner Center.

The manifest identity must exactly match the reserved Partner Center product:

- Identity name: `Codeburn.CodeBurn`
- Publisher: `CN=3EFA3336-87E1-46F2-9DFA-2EB5A7693F89`
- Publisher display name: `Codeburn`
- Store ID: `9P0R4ZL5XMB8`

The Store package is intentionally unsigned: Microsoft signs it during Store
submission. Direct sideloading requires a separate trusted or development
certificate. The AppX declares `runFullTrust` (electron-builder's required
default for Electron apps), so CodeBurn retains access to the user's local
provider session files rather than running in a UWP application sandbox.

The tray app ships inside this package too (`app\resources\menubar\`), with a
`windows.startupTask` extension for launch at login. `msiexec` is never run on
this route. See "The Store route" above.

### Linux (`package:linux`)

`electron-builder --linux` produces a single artifact in `app/release/`:

- **`CodeBurn-0.9.15.AppImage`** — a self-contained AppImage (no install step,
  no package manager).

Config (`build.linux`):

- `linux.target: AppImage`, `arch: x64`.
- `linux.category: "Development"` — the freedesktop menu category.
- `linux.icon: build/icon.png` — reuses the same source PNG.
- `linux.maintainer: "AgentSeal <hello@agentseal.org>"` — matches the root
  `package.json` author.
- `linux.executableName: "codeburn"` — the binary name inside the AppImage
  (lowercase, no spaces), distinct from the `CodeBurn` product name.

After downloading, the AppImage must be made executable before it will run:

```sh
chmod +x CodeBurn-0.9.15.AppImage
./CodeBurn-0.9.15.AppImage
```

The build logs one benign warning — `desktopName is not set` — which only
affects how some desktop environments group the app's windows in the
taskbar/dock; it does not affect packaging or launch.

## Releases

When a maintainer cuts a desktop release, the GitHub tag convention is:

```
desktop-v<version>      # e.g. desktop-v0.9.15
```

This mirrors the menubar's `mac-v<version>` convention (see `../RELEASING.md`)
and keeps the desktop app's tags in their own namespace, separate from the CLI
(`v<version>`) and the menubar (`mac-v<version>`).

Pushing a `desktop-v<version>` tag runs the `Build Windows installer` workflow
on `windows-latest`. The workflow requires the tag version, root package
version, and app package version to agree, and it fails unless the build emits
exactly one `CodeBurn-Setup-<version>.exe` and one matching
`.exe.blockmap` at the top level of `app/release/`. It uploads those exact
top-level filenames as the `CodeBurn-Windows-Installer`
Actions artifact. The workflow has read-only repository permissions and does
**not** publish release assets automatically. Artifacts are retained for 30 days.

Before publishing the GitHub Release, the release owner must download that
workflow artifact and manually upload both Windows files along with the four
macOS `.dmg`/`.zip` files, `CodeBurn-<version>.AppImage`,
`codeburn-desktop_<version>_amd64.deb`, and
`codeburn-desktop-<version>.x86_64.rpm`. Confirm the live release contains
every required platform asset before announcing it. The
website's download links **pin that tag** in their URLs, so a release with a
missing installer is broken even when another Windows distribution channel is
available. The Windows installer uses an explicit `nsis.artifactName` of
`CodeBurn-Setup-${version}.${ext}`.

Publishing the Release triggers a read-only live-asset check. If the files are
uploaded afterward, rerun the workflow manually with `release_tag` set to the
existing `desktop-v<version>` tag and require the verification job to pass.

## Verifying a build

```sh
codesign -dv --verbose=2 app/release/mac-arm64/CodeBurn.app
codesign --verify --deep --strict app/release/mac-arm64/CodeBurn.app
```

Expect `Signature=adhoc`, a real `Identifier=org.agentseal.codeburn-desktop`,
and `Sealed Resources` present. The deep-verify command should exit 0.

To smoke-test that the packaged renderer actually loads (the classic failure
is a white screen from a wrong `loadFile` path once assets are behind
`app.asar`), launch the built binary directly and confirm the process tree
stays up and the main process logs no `did-fail-load` errors:

```sh
"app/release/mac-arm64/CodeBurn.app/Contents/MacOS/CodeBurn" --user-data-dir=/tmp/codeburn-smoke
```

A healthy launch spawns `CodeBurn`, `CodeBurn Helper` (gpu-process),
`CodeBurn Helper` (utility/network), and `CodeBurn Helper (Renderer)`
processes and keeps running with no stderr output. `main.ts`'s
`did-fail-load` handler (`console.error('Renderer failed to load ...')`)
prints to that same stderr if the packaged `loadFile(path.join(__dirname,
'..', 'renderer', 'index.html'))` path is ever wrong.

## The Gatekeeper story (no paid Apple Developer account)

Ad-hoc signing satisfies the *kernel's* code-signing requirement (Apple
Silicon refuses to execute anything with no signature at all), but it is not
a Developer ID signature and the app is not notarized. Concretely:

- `spctl --assess --type execute` on the built app returns **`rejected`**,
  ad-hoc-signed or not, quarantined or not. `spctl`'s static assessment
  checks for a Developer ID + notarization ticket, which this build does
  not have and cannot have without a paid account.
- Any file downloaded through a browser (or unzipped by Finder's Archive
  Utility from a browser download) gets a `com.apple.quarantine` extended
  attribute. The first time a quarantined, non-notarized app is opened,
  Gatekeeper blocks a plain double-click with "Apple could not verify that
  \[CodeBurn] is free of malware."
- **This is expected and correct for an unpaid, unnotarized build.** Being
  a known GitHub author, signing the repo's commits, or ad-hoc signing the
  binary does **not** change this — none of that is a substitute for an
  Apple-issued Developer ID certificate plus notarization.

### First-open instructions for users

**Field-verified on macOS 15+ (Sequoia/Tahoe): an ad-hoc-signed, quarantined
app gets the harsher "\[CodeBurn] is damaged and can't be opened. You should
move it to the Trash." dialog, and the classic right-click → Open bypass does
NOT work for it** (that trick only helps Developer-ID-signed, unnotarized
apps). The reliable path is stripping the quarantine attribute:

```sh
# after dragging CodeBurn.app from the dmg into /Applications
xattr -cr /Applications/CodeBurn.app
```

One time only; subsequent launches work normally. **System Settings →
Privacy & Security → "Open Anyway"** may also appear after a blocked attempt
and works when offered, but is not shown in all cases for ad-hoc builds —
document the `xattr` path as primary anywhere user-facing.

None of these steps are needed for a `dmg`/`zip` built and opened locally on
the same machine (no quarantine attribute is applied to files that were never
downloaded) — they only apply to a build distributed to someone else, e.g.
via a GitHub Release.

### Folder-access prompts re-appear on every update

CodeBurn requests access to folders like Documents, Desktop, and Downloads
(via `mac.extendInfo` in `app/package.json`) to read local AI coding tool
session logs. Because each ad-hoc/unsigned build has no stable Developer ID,
macOS TCC treats every rebuild as a new app identity, so users get
re-prompted for folder access after each update even though nothing else
changed. Signing with a stable Developer ID certificate (see "Upgrade path"
below) fixes this — TCC grants persist across updates once the app's
identity is stable.

## Upgrade path: paid account + notarization

When a paid Apple Developer Program membership is available, the same
`electron-builder` config takes the upgrade with a few changes, no new
tooling:

- Set `mac.identity` to the real `"Developer ID Application: <Name> (<TEAMID>)"`
  certificate name (or let electron-builder auto-discover it from the
  keychain by removing `identity` entirely), and set `mac.hardenedRuntime:
  true` with an entitlements file.
- Add a `notarize` block (or the `afterSign` hook electron-builder's
  `@electron/notarize` integration expects) with an app-specific password or
  API key, and remove `gatekeeperAssess: false` so electron-builder verifies
  the notarized result itself.
- Everything else — `appId`, `files`, `mac.target` (dmg/zip, arm64+x64),
  `icon`, `directories.output` — stays as-is.

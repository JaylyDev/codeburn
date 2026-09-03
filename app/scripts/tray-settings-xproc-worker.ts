// One party in the cross-process lock test. The Rust side (windows/src-tauri/src/dock.rs, test
// `concurrent_node_and_rust_patches_to_the_dock_file_both_survive`) spawns this with a shared
// home directory, so a real Node process and a real Rust process hammer windows-dock.json at
// once. Each patches its OWN key with a counter that only ever rises; the Rust side watches the
// file from a reader thread, and a counter seen to fall there is a write the other side erased.
//
// It lives in scripts/ rather than electron/ so it is neither bundled into the app nor picked up
// as a vitest test, only run on demand by the Rust test.
//
// argv: <home> <key> <iterations> <barriersDir>
// CB_TRAY_XPROC_NOLOCK=1 replays the same read/modify/write WITHOUT the lock, which is the bug
// the test catches; the Rust side reads the same variable so one env toggles both parties.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { patchTrayFile, readTrayFile, writeFileAtomic } from '../electron/tray-settings'

const [home, key, itersRaw, barriers] = process.argv.slice(2)
if (!home || !key || !itersRaw || !barriers) {
  console.error('usage: tray-settings-xproc-worker <home> <key> <iterations> <barriersDir>')
  process.exit(2)
}
const iters = Number(itersRaw)
const nolock = process.env['CB_TRAY_XPROC_NOLOCK'] === '1'
const dockPath = join(home, '.config', 'codeburn', 'windows-dock.json')

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

function waitFor(path: string): void {
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    sleepSync(10)
  }
}

// Started, but do not race ahead: wait for the go barrier so both loops overlap.
writeFileSync(join(barriers, 'node.ready'), '')
waitFor(join(barriers, 'go'))

for (let i = 0; i < iters; i++) {
  if (nolock) {
    const current = readTrayFile('dock', home)
    // Widen the read/modify/write window so the lost update is easy to provoke.
    sleepSync(1)
    writeFileAtomic(dockPath, `${JSON.stringify({ ...current, [key]: i }, null, 2)}\n`)
  } else {
    patchTrayFile('dock', { [key]: i }, home)
  }
  if (i % 7 === 0) sleepSync(1)
}

writeFileSync(join(barriers, 'node.done'), '')

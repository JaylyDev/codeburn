#!/usr/bin/env node
// Refuses to let a half-built dist reach npm.
//
// `npm run build` is `tsup && tsc`. tsup runs with clean:true, so it wipes dist
// and writes JavaScript; if tsc then fails, dist holds .js with no declarations.
// The build exits non-zero, but nothing rebuilds at publish time, so a later
// `npm publish` would ship a package whose every `types` target 404s. Verified:
// removing the declarations and running `npm pack --dry-run` succeeds with
// 41/41 exports subpaths pointing at files that are not in the tarball.
//
// This script is the assertion that closes that gap. It runs from
// `prepublishOnly` (after the build) and in CI, so it is exercised on every
// push rather than only on the rare publish.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

const problems = []
let checked = 0

for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
  for (const condition of ['import', 'types']) {
    const relative = entry?.[condition]
    if (!relative) {
      problems.push(`exports["${subpath}"] declares no "${condition}" target`)
      continue
    }
    checked++
    if (!existsSync(join(pkgRoot, relative))) {
      problems.push(`exports["${subpath}"].${condition} -> ${relative} does not exist`)
    }
  }
}

// `files` decides what actually ships; a target outside it is unreachable to a
// consumer even when it exists on disk here.
const shipped = pkg.files ?? []
if (!shipped.includes('dist')) {
  problems.push('package.json#files does not include "dist", so no export target would ship')
}

if (problems.length > 0) {
  console.error(`dist verification failed (${problems.length} problem(s)):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nRun `npm run build --workspace=@codeburn/core` and re-check.')
  process.exit(1)
}

console.log(
  `dist verified: ${checked} export targets across ${Object.keys(pkg.exports ?? {}).length} subpaths all present`,
)

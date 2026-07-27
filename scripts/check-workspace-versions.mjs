#!/usr/bin/env node
// Fails when the monorepo root, the CLI, and @codeburn/core drift apart.
// The CLI must depend on the exact core version it ships with, otherwise a
// published CLI can resolve a core it was never tested against.
//
// package-lock.json is checked too. Comparing only the manifests leaves the
// gate blind to the case it exists for: all three manifests can agree while the
// lockfile still records a stale workspace version, and `npm ci` does not
// reject that (verified on npm 10.9.2, 11.12.1, 11.16.0, 11.17.0). A gate that
// cannot catch its own failure mode is decoration.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (relative) => {
  const path = join(repoRoot, relative)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${relative}: ${error.message}`)
  }
}

const root = read('package.json')
const cli = read('packages/cli/package.json')
const core = read('packages/core/package.json')
const lock = read('package-lock.json')

const coreDep = cli.dependencies?.['@codeburn/core']

const problems = []

if (root.version !== cli.version) {
  problems.push(`root version ${root.version} !== cli version ${cli.version}`)
}
if (root.version !== core.version) {
  problems.push(`root version ${root.version} !== core version ${core.version}`)
}
if (coreDep !== core.version) {
  problems.push(
    `packages/cli depends on "@codeburn/core": ${JSON.stringify(coreDep)}, expected the exact core version "${core.version}"`,
  )
}

// --- lockfile agreement -----------------------------------------------------

const lockEntry = (key) => lock.packages?.[key]

if (!lock.packages) {
  problems.push('package-lock.json has no "packages" map; expected lockfileVersion 2 or 3')
} else {
  const expected = [
    ['', root.version, 'root'],
    ['packages/cli', cli.version, 'packages/cli'],
    ['packages/core', core.version, 'packages/core'],
  ]
  for (const [key, manifestVersion, label] of expected) {
    const entry = lockEntry(key)
    if (!entry) {
      problems.push(`package-lock.json is missing an entry for ${label}`)
      continue
    }
    if (entry.version !== manifestVersion) {
      problems.push(
        `package-lock.json records ${label} at ${entry.version}, but its manifest says ${manifestVersion}`,
      )
    }
  }

  const lockedDep = lockEntry('packages/cli')?.dependencies?.['@codeburn/core']
  if (lockedDep !== undefined && lockedDep !== coreDep) {
    problems.push(
      `package-lock.json records the CLI's core dependency as ${JSON.stringify(lockedDep)}, but packages/cli/package.json says ${JSON.stringify(coreDep)}`,
    )
  }
}

if (problems.length > 0) {
  console.error('workspace version check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nSet root, packages/cli, and packages/core to the same version,')
  console.error('pin the CLI dependency to that exact version, then run:')
  console.error('  npm install --package-lock-only --ignore-scripts')
  process.exit(1)
}

console.log(`workspace versions and package-lock.json agree at ${root.version}`)

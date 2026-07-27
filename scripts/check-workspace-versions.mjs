#!/usr/bin/env node
// Fails when the monorepo root, the CLI, and @codeburn/core drift apart.
// The CLI must depend on the exact core version it ships with, otherwise a
// published CLI can resolve a core it was never tested against.
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

if (problems.length > 0) {
  console.error('workspace version check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nSet root, packages/cli, and packages/core to the same version,')
  console.error('pin the CLI dependency to that exact version, then run:')
  console.error('  npm install --package-lock-only --ignore-scripts')
  process.exit(1)
}

console.log(`workspace versions agree at ${root.version}`)

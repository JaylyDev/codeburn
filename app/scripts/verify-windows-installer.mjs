#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

function fail(message) {
  console.error(`Windows installer manifest invalid: ${message}`)
  process.exitCode = 1
}

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}

function packageVersion(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version
}

function filesBelow(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => basename(entry.name))
}

try {
  const root = resolve(option('--root', new URL('../..', import.meta.url).pathname))
  const artifacts = resolve(option('--artifacts', join(root, 'app', 'release')))
  const tag = option('--tag', '')
  const rootVersion = packageVersion(join(root, 'package.json'))
  const appVersion = packageVersion(join(root, 'app', 'package.json'))

  if (rootVersion !== appVersion) {
    fail(`root version ${rootVersion} does not match app version ${appVersion}`)
  }

  if (tag && tag !== `desktop-v${appVersion}`) {
    fail(`${tag} does not match app version ${appVersion}`)
  }

  const files = filesBelow(artifacts)
  const expectedArtifacts = [
    `CodeBurn-Setup-${appVersion}.exe`,
    `CodeBurn-Setup-${appVersion}.exe.blockmap`,
  ]
  for (const expected of expectedArtifacts) {
    const count = files.filter(file => file === expected).length
    if (count !== 1) fail(`expected exactly one ${expected}, found ${count}`)
  }

  const installerArtifacts = files.filter(file => /^CodeBurn-Setup-.*\.exe(?:\.blockmap)?$/.test(file))
  const unexpected = installerArtifacts.filter(file => !expectedArtifacts.includes(file))
  if (unexpected.length > 0) {
    fail(`unexpected Windows installer artifacts: ${unexpected.join(', ')}`)
  }

  if (!process.exitCode) {
    console.log(`Windows installer manifest verified for ${appVersion}`)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

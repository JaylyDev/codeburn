import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, it, expect } from 'vitest'

const CLI_TIMEOUT_MS = 10_000

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOMEPATH: home,
      HOMEDRIVE: '',
    },
    encoding: 'utf-8',
  })
}

function readConfig(home: string): Promise<Record<string, unknown>> {
  return readFile(join(home, '.config', 'codeburn', 'config.json'), 'utf-8')
    .then(raw => JSON.parse(raw) as Record<string, unknown>)
}

describe('codeburn model-flat-rate command', () => {
  it('saves, lists, and removes a flat-rate mark', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-flat-rate-'))
    try {
      const set = runCli(['model-flat-rate', 'auto-genius'], home)
      expect(set.status).toBe(0)
      expect(set.stdout).toContain('Flat-rate mark saved: auto-genius')

      const saved = await readConfig(home)
      expect(saved.flatRateModels).toEqual(['auto-genius'])

      const list = runCli(['model-flat-rate', '--list'], home)
      expect(list.status).toBe(0)
      expect(list.stdout).toContain('auto-genius')

      const remove = runCli(['model-flat-rate', '--remove', 'auto-genius'], home)
      expect(remove.status).toBe(0)

      const after = await readConfig(home)
      expect(after.flatRateModels).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('warns when the same model is also configured in modelAliases', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-flat-rate-'))
    try {
      expect(runCli(['model-alias', 'auto-genius', 'gpt-4o'], home).status).toBe(0)
      const set = runCli(['model-flat-rate', 'auto-genius'], home)
      expect(set.status).toBe(0)
      expect(set.stdout).toContain('also in modelAliases')
      expect(set.stdout).toContain('invents per-token spend')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('rejects a remove for an unknown mark', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-flat-rate-'))
    try {
      const result = runCli(['model-flat-rate', '--remove', 'unknown-sku'], home)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('No flat-rate mark found')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)
})

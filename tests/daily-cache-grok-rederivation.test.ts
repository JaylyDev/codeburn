import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  currentTzKey,
  ensureCacheHydrated,
  toDateString,
  type DailyEntry,
} from '../src/daily-cache.js'

const PRE_FIX_DAILY_VERSION = 18
const cacheRoot = join(tmpdir(), `codeburn-grok-daily-${process.pid}-${Date.now()}`)

function day(date: string, cost: number): DailyEntry {
  return {
    date,
    cost,
    savingsUSD: 0,
    calls: 1,
    sessions: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {
      'Grok Build': {
        calls: 1,
        cost,
        savingsUSD: 0,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      },
    },
    categories: {},
    providers: {
      grok: {
        calls: 1,
        cost,
        savingsUSD: 0,
        sessions: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      },
    },
  }
}

beforeEach(async () => {
  process.env['CODEBURN_CACHE_DIR'] = cacheRoot
  await rm(cacheRoot, { recursive: true, force: true })
  await mkdir(cacheRoot, { recursive: true })
})

afterEach(async () => {
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('Grok daily-cache accounting rederivation', () => {
  it('re-derives a v18 Grok day while preserving the old cache as the baseline', async () => {
    const date = toDateString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    const yesterday = toDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))
    const oldPath = join(cacheRoot, `daily-cache.v${PRE_FIX_DAILY_VERSION}.json`)
    const oldCache = {
      version: PRE_FIX_DAILY_VERSION,
      savingsConfigHash: 'cfg',
      tzKey: currentTzKey(),
      lastComputedDate: yesterday,
      days: [day(date, 99)],
      complete: true,
      watermarkTrusted: true,
    }
    await writeFile(oldPath, JSON.stringify(oldCache))

    let parseCount = 0
    const corrected = day(date, 2)
    const hydrated = await ensureCacheHydrated(
      async () => {
        parseCount++
        return []
      },
      () => [corrected],
      'cfg',
      () => true,
    )

    const refreshedDay = hydrated.days.find(entry => entry.date === date)
    expect(parseCount).toBe(1)
    expect(refreshedDay?.providers.grok?.cost).toBe(2)
    expect(refreshedDay?.cost).toBe(2)
    expect(JSON.parse(await readFile(oldPath, 'utf8'))).toEqual(oldCache)
  })
})

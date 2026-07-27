import { join } from 'path'
import { homedir } from 'os'

import { decodeVscodeCline } from '@codeburn/core/providers/vscode-cline'
import type { VscodeClineDecodedCall } from '@codeburn/core/providers/vscode-cline'

import { createBridgedProvider } from './bridge.js'
import { getShortModelName } from '../models.js'
import { discoverClineTasksInBaseDirs, readClineRecords, toClineProviderCall } from './vscode-cline-parser.js'
import type { Provider, SessionSource } from './types.js'

const PROVIDER_NAME = 'ibm-bob'
const DISPLAY_NAME = 'IBM Bob'
const EXTENSION_ID = 'ibm.bob-code'
const FALLBACK_MODEL = 'ibm-bob-auto'

export function getIBMBobGlobalStorageDirs(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID),
      join(home, 'Library', 'Application Support', 'Bob-IDE', 'User', 'globalStorage', EXTENSION_ID),
    ]
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return [
      join(appData, 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID),
      join(appData, 'Bob-IDE', 'User', 'globalStorage', EXTENSION_ID),
    ]
  }
  const configHome = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config')
  return [
    join(configHome, 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID),
    join(configHome, 'Bob-IDE', 'User', 'globalStorage', EXTENSION_ID),
  ]
}

export function createIBMBobProvider(overrideDir?: string): Provider {
  return createBridgedProvider<VscodeClineDecodedCall>({
    name: PROVIDER_NAME,
    displayName: DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dirs = overrideDir ? [overrideDir] : getIBMBobGlobalStorageDirs()
      return discoverClineTasksInBaseDirs(dirs, PROVIDER_NAME, DISPLAY_NAME)
    },

    decode: input => decodeVscodeCline({ ...input, fallbackModel: FALLBACK_MODEL }),
    readRecords: readClineRecords,
    toProviderCall: toClineProviderCall,
  })
}

export const ibmBob = createIBMBobProvider()

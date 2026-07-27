import { decodeVscodeCline } from '@codeburn/core/providers/vscode-cline'
import type { VscodeClineDecodedCall } from '@codeburn/core/providers/vscode-cline'

import { createBridgedProvider } from './bridge.js'
import { discoverClineTasks, readClineRecords, toClineProviderCall } from './vscode-cline-parser.js'
import type { Provider, SessionSource } from './types.js'

const EXTENSION_ID = 'rooveterinaryinc.roo-cline'

export function createRooCodeProvider(overrideDir?: string | string[]): Provider {
  return createBridgedProvider<VscodeClineDecodedCall>({
    name: 'roo-code',
    displayName: 'Roo Code',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverClineTasks(EXTENSION_ID, 'roo-code', 'Roo Code', overrideDir)
    },

    readRecords: readClineRecords,
    decode: input => decodeVscodeCline(input),
    toProviderCall: toClineProviderCall,
  })
}

export const rooCode = createRooCodeProvider()

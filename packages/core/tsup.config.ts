import { defineConfig } from 'tsup'

export default defineConfig({
  // One entry per exports-map subpath. `internal/*` is deliberately excluded so
  // `zod-to-json-schema` never enters the runtime bundle.
  entry: [
    'src/index.ts',
    'src/schema.ts',
    'src/observations.ts',
    'src/diagnostics.ts',
    'src/fingerprint.ts',
    'src/contracts.ts',
    'src/providers/claude/index.ts',
    'src/providers/codex/index.ts',
  ],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
})

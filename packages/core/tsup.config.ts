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
    'src/detectors/index.ts',
    'src/providers/claude/index.ts',
    'src/providers/codebuff/index.ts',
    'src/providers/codewhale/index.ts',
    'src/providers/codex/index.ts',
    'src/providers/grok/index.ts',
    'src/providers/kimi/index.ts',
    'src/providers/qwen/index.ts',
    'src/providers/zerostack/index.ts',
    'src/providers/droid/index.ts',
    'src/providers/mux/index.ts',
    'src/providers/openclaw/index.ts',
    'src/providers/open-design/index.ts',
    'src/providers/lingtai-tui/index.ts',
  ],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
})

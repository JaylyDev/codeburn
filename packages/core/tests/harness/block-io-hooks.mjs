// ESM loader hook (registered by block-io-register.mjs). Throws on resolution of
// any I/O-capable core module, so if @codeburn/core touches the filesystem, a
// child process, or the network at import time — or during a trivial call — the
// import fails and the import-smoke guardrail catches it.
const BANNED = new Set([
  'fs',
  'fs/promises',
  'child_process',
  'net',
  'http',
  'https',
  'dns',
  'dns/promises',
])

export async function resolve(specifier, context, nextResolve) {
  const bare = specifier.replace(/^node:/, '')
  if (BANNED.has(bare)) {
    throw new Error(`import-smoke: blocked I/O module import "${specifier}"`)
  }
  return nextResolve(specifier, context)
}

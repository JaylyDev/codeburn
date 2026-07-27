// Discovery-side helper retained from the old OpenCode session-message module.
// The shared decode logic (the assistant-turn builder, tool-name normalization,
// timestamp parsing, and the message/part types) moved to
// @codeburn/core/providers/opencode-session.

export function sanitize(dir: string): string {
  return dir.replace(/^\//, '').replace(/\//g, '-')
}

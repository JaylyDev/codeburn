/// What CodeBurn watches for, in one place. Two surfaces answer the first-run question
/// "where does this look?": the empty state and the dimmed tab in the strip's known-tool
/// fallback. They used to answer it differently (the strip said "Pi session logs" where the
/// empty state said `~/.pi`, and neither was the directory the CLI reads), so both read this
/// table now.
///
/// The paths are the roots the CLI's own providers probe (`probeRoots` in
/// src/providers/<tool>.ts), spelled the way the reader's OS spells them. A provider that
/// resolves several roots is named by the one a reader can act on.

import { appDataPath, homePath } from './platform'

export type WatchedTool = {
  /// The CLI provider id, which is also what `--provider` takes.
  id: string
  /// The tab chip label.
  label: string
  /// The tool's own name, for a sentence.
  tool: string
  path: string
}

export const WATCHED_TOOLS: WatchedTool[] = [
  { id: 'claude', label: 'Claude', tool: 'Claude Code', path: homePath('.claude', 'projects') },
  { id: 'codex', label: 'Codex', tool: 'Codex CLI', path: homePath('.codex', 'sessions') },
  { id: 'cursor', label: 'Cursor', tool: 'Cursor', path: appDataPath('Cursor', 'User', 'globalStorage') },
  { id: 'copilot', label: 'Copilot', tool: 'GitHub Copilot', path: homePath('.copilot') },
  { id: 'opencode', label: 'OpenCode', tool: 'OpenCode', path: homePath('.local', 'share', 'opencode') },
  { id: 'pi', label: 'Pi', tool: 'Pi', path: homePath('.pi', 'agent', 'sessions') },
]

/// The phrase both surfaces put after "CodeBurn watches".
export function watchedSource(tool: WatchedTool): string {
  return `${tool.tool} sessions in ${tool.path}`
}

/// Paths shown in copy use the reader's own OS spelling.

export const IS_WINDOWS = navigator.userAgent.includes('Windows')

const HOME = IS_WINDOWS ? '%USERPROFILE%' : '~'
const SEP = IS_WINDOWS ? '\\' : '/'

export function homePath(...parts: string[]): string {
  return [HOME, ...parts].join(SEP)
}

/// Where the VS Code family, Cursor with it, keeps per-user state. The CLI reads `%APPDATA%`
/// on Windows and `~/.config` on Linux; macOS has its own spelling and its own app.
export function appDataPath(...parts: string[]): string {
  return [IS_WINDOWS ? '%APPDATA%' : '~/.config', ...parts].join(SEP)
}

/// Today's spend in the tray is a second tray icon carrying the number as its bitmap. Only
/// the Windows notification area gives us one; the Linux SNI tray has no equivalent, and
/// macOS ships the Swift menubar instead. Where this is false the control is hidden and the
/// Rust command is never called.
export const TRAY_BADGE_SUPPORTED = IS_WINDOWS

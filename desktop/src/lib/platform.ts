/// Paths shown in copy use the reader's own OS spelling.

export const IS_WINDOWS = navigator.userAgent.includes('Windows')

const HOME = IS_WINDOWS ? '%USERPROFILE%' : '~'
const SEP = IS_WINDOWS ? '\\' : '/'

export function homePath(...parts: string[]): string {
  return [HOME, ...parts].join(SEP)
}

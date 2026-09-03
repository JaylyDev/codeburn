/**
 * Points the home directory at `dir` for the code under test, or clears it.
 *
 * `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, never the other, so a
 * test that sets only HOME still resolves the real home on Windows: fixtures come back
 * empty and, worse, the code under test writes into the developer's real
 * `~/.config/codeburn`. Every test that moves home goes through here so both move together.
 */
export function setHome(dir: string | undefined): void {
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    if (dir === undefined) delete process.env[key]
    else process.env[key] = dir
  }
}

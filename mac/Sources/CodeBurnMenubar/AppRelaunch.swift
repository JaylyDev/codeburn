import AppKit

/// Restarts the app from inside itself.
///
/// Who starts the new process matters, not just that it starts: macOS holds
/// the process that asked LaunchServices to open an app responsible for it,
/// and a menu bar reopened by the desktop app counts as a different
/// responsible process — which is why the "access data from other apps"
/// prompt came back on every language change. Launched from here, the app is
/// responsible for itself and the permission it was already granted stands.
///
/// `-n` because the OS still has this (terminating) instance registered under
/// the same bundle path, so a plain `open` would activate it instead of
/// starting anything. The overlap is safe: `SingleInstanceGuard` keeps the
/// newest launch, which is the new copy.
enum AppRelaunch {
    @MainActor
    static func now() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        // The bundle path is an argument, not part of the script: a path with a quote or a
        // `$` in it would otherwise be read as shell syntax.
        task.arguments = ["-c", "sleep 0.6; open -n \"$1\"", "sh", Bundle.main.bundlePath]
        try? task.run()
        NSApp.terminate(nil)
    }
}

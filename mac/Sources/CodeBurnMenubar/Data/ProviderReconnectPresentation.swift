import Foundation

struct ProviderReconnectPresentation: Sendable, Equatable {
    let title: String
    let defaultReason: String
    let instruction: String

    init(provider: ProviderFilter) {
        title = "Reconnect \(provider.rawValue)"
        switch provider {
        case .claude:
            defaultReason = "Claude Code credentials need to be refreshed."
            instruction = "Open Claude Code in your terminal and type `/login`, then click Reconnect."
        case .codex:
            defaultReason = "Codex credentials need to be refreshed."
            instruction = "Run `codex login` in your terminal, then click Reconnect."
        case .kimiCode:
            defaultReason = "Kimi Code credentials need to be refreshed."
            instruction = "Run the Kimi CLI once to refresh your login, then click Reconnect."
        case .gemini:
            defaultReason = "Gemini credentials need to be refreshed."
            instruction = "Run the Gemini CLI once to refresh your login, then click Reconnect."
        case .copilot:
            defaultReason = "Copilot credentials need to be refreshed."
            instruction = "Sign in with the Copilot CLI, an editor plugin, or `gh auth login`, then click Reconnect."
        case .antigravity:
            defaultReason = "The local Antigravity service is unavailable."
            instruction = "Start the Antigravity app, then click Reconnect."
        default:
            defaultReason = "\(provider.rawValue) credentials need to be refreshed."
            instruction = "Sign in to \(provider.rawValue) again, then retry."
        }
    }
}

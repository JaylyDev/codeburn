import { refreshQuota, summaryFor, type Connection, type QuotaState } from '../lib/quota'
import { Group, Note, Pane } from './controls'
import { CheckCircleIcon, KeySlashIcon, RetryIcon, WarningIcon } from '../components/Icons'

/// One pane per provider the CLI has a live quota adapter for, from the mac's
/// ClaudeSettingsTab / CodexSettingsTab / ... and GenericProviderSettingsTab.
///
/// The Windows side has one connection story for all ten: `codeburn quota` reads whatever
/// credential the provider's own app or CLI already wrote, so there is nothing to connect
/// and nothing to disconnect. What the mac spells as Connect / Disconnect / Reconnect is
/// Retry here, plus the instruction that says where the credential is supposed to come from.

/// ProviderConnectionGuidance.instruction, resolved per provider rather than from a catalog
/// of auth methods this app does not carry.
const GUIDANCE: Record<string, string> = {
  claude: 'Sign in to Claude Code (run `claude` and type /login), then click Retry.',
  codex: 'Run `codex login` and choose a ChatGPT plan, then click Retry.',
  gemini: 'Run the Gemini CLI once to sign in, then click Retry.',
  copilot: 'Sign in with the Copilot CLI or an editor Copilot plugin, then click Retry.',
  antigravity: 'Start the Antigravity app, then click Retry.',
  kimi: 'Sign in with the Kimi CLI, then click Retry.',
  cursor: 'Sign in to the Cursor app, then click Retry.',
  zai: 'Sign in with the Pi CLI, or set ZAI_API_KEY, then click Retry.',
  grok: 'Sign in with the Grok CLI, then click Retry.',
  clinepass: 'Set CLINEPASS_API_KEY, then click Retry.',
}

/// The mac's "How it works" sections, with the Windows paths. Every one of these is
/// read-only: nothing is copied into a store of CodeBurn's own.
const HOW_IT_WORKS: Record<string, string> = {
  claude: 'Claude quota is read from the Claude Code credentials already on this machine, then checked against Anthropic. Only the plan and the rate-limit windows come back; no conversation content is read.',
  codex: 'Codex quota follows the authoritative %USERPROFILE%\\.codex\\auth.json session directly. Only ChatGPT-mode auth (Plus, Pro, Team, Business, Edu, Enterprise) reports rate-limit windows; API-key users are billed per request and have a different reporting surface. Credit-metered workspaces report their monthly credit allowance instead.',
  gemini: 'Gemini quota reads %USERPROFILE%\\.gemini\\oauth_creds.json read-only and asks Google Code Assist. Tokens stay in memory. If it shows as expired, run the Gemini CLI once to refresh your login, then click Retry.',
  copilot: 'Copilot quota reads a GitHub token that is already on this machine, read-only: the editor plugin files under %LOCALAPPDATA%\\github-copilot first, then the Copilot CLI files. Usage tracking works without any of this; only the live quota bars need a token.',
  antigravity: 'Antigravity quota talks to the local Antigravity language server on 127.0.0.1 only. Nothing leaves the machine and no credential files are read. If it shows as disconnected, start the Antigravity app, then click Retry.',
  kimi: 'Kimi Code quota reads %USERPROFILE%\\.kimi-code\\credentials\\kimi-code.json directly. Access tokens are short-lived and only the Kimi CLI refreshes them, so if the connection shows as expired, run the Kimi CLI once and click Retry.',
  cursor: 'Cursor quota opens the Cursor editor state database read-only for its access token, then asks cursor.com. Nothing is written back, so an expired token can only be refreshed by signing in to Cursor again.',
  zai: 'Z.ai quota uses a supplied API key if there is one, and otherwise the Z.ai login the Pi CLI keeps in %USERPROFILE%\.pi\agent\auth.json.',
  grok: 'Grok Build quota reads %USERPROFILE%\\.grok\\auth.json, preferring the current OIDC scope over an older sign-in entry.',
  clinepass: 'ClinePass has no local login file, so the only credential is an API key.',
}

type Props = {
  id: string
  name: string
  quota: QuotaState
}

export function ProviderPane({ id, name, quota }: Props) {
  const summary = summaryFor(quota, id)
  const connection: Connection | null = summary?.connection ?? null
  const guidance = GUIDANCE[id] ?? 'Sign in with the provider app or CLI, then click Retry.'

  const title =
    connection === 'connected' ? 'Connected'
      : connection === 'stale' ? 'Refreshing...'
        : connection === 'loading' ? 'Connecting...'
          : connection === 'transientFailure' ? 'Retrying'
            : connection === 'terminalFailure' ? 'Reconnect required'
              : 'Not connected'

  const detail =
    connection === 'connected' || connection === 'stale'
      ? (summary?.planLabel ? `Plan: ${summary.planLabel}` : 'Live quota is available to the popover and the Capacity Dock.')
      : connection === 'transientFailure'
        ? quota.error ?? 'The last refresh failed; the next one is already scheduled.'
        : connection === 'terminalFailure'
          ? [summary?.reason, guidance].filter(Boolean).join(' ')
          : quota.providers.length === 0
            ? 'Waiting for the first quota reading.'
            : guidance

  return (
    <Pane>
      <Group title="Connection" footer={`CodeBurn reads whatever credential ${name} already wrote on this machine. It never copies one into a store of its own.`}>
        <div className="stg-row">
          <div className="stg-conn">
            <span className={`stg-conn-icon stg-conn-${connection ?? 'disconnected'}`}>
              {connection === 'connected' || connection === 'stale' ? <CheckCircleIcon size={16} />
                : connection === 'terminalFailure' ? <WarningIcon size={16} />
                  : connection === 'transientFailure' ? <RetryIcon size={16} />
                    : <KeySlashIcon size={16} />}
            </span>
            <div className="stg-row-text">
              <div className="stg-row-label">{title}</div>
              <div className="stg-row-hint">{detail}</div>
            </div>
          </div>
          <div className="stg-row-control">
            <button
              type="button"
              className={`btn ${quota.loading ? 'btn-spinning' : ''}`}
              disabled={quota.loading}
              onClick={() => { void refreshQuota() }}
            >
              {quota.loading ? 'Checking...' : 'Retry'}
            </button>
          </div>
        </div>
        {summary && summary.windows.length > 0 && (
          <Note>
            {summary.windows.map(window => `${window.label} ${Math.round(window.usedPct)}%`).join('  ·  ')}
          </Note>
        )}
      </Group>

      <Group title="How it works">
        <Note>{HOW_IT_WORKS[id] ?? `${name} quota comes from the codeburn CLI, which reads the credential the provider's own tools left on this machine.`}</Note>
      </Group>
    </Pane>
  )
}

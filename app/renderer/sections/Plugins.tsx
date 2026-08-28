import { useEffect, useState } from 'react'
import { codeburn } from '../lib/ipc'
import styles from './Plugins.module.css'

interface PluginInfo {
  name: string
  version: string
  status: 'loaded' | 'rejected'
  reason?: string
  capabilities?: {
    commands: string[]
    syncAttributes: Array<{ key: string; disclosure: string }>
    payloadSections: string[]
    spanKinds: string[]
  }
}

export function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadPlugins()
  }, [])

  async function loadPlugins() {
    try {
      setLoading(true)
      const result = await codeburn.pluginList()
      setPlugins(result as PluginInfo[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPlugins([])
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className={styles.container}>Loading plugins...</div>
  }

  return (
    <div className={styles.container}>
      <h1>Plugins</h1>
      {error && <div className={styles.error}>{error}</div>}
      {plugins.length === 0 ? (
        <div className={styles.empty}>
          <p>No plugins installed</p>
          <button onClick={() => void loadPlugins()}>Refresh</button>
        </div>
      ) : (
        <div className={styles.list}>
          {plugins.map(plugin => (
            <div key={plugin.name} className={styles.row} data-status={plugin.status}>
              <div className={styles.info}>
                <div className={styles.name}>{plugin.name}@{plugin.version}</div>
                {plugin.status === 'rejected' && (
                  <div className={styles.reason}>{plugin.reason}</div>
                )}
                {plugin.capabilities && (
                  <div className={styles.caps}>
                    {plugin.capabilities.commands.length > 0 && (
                      <span>commands {plugin.capabilities.commands.length}</span>
                    )}
                    {plugin.capabilities.syncAttributes.length > 0 && (
                      <span>fields {plugin.capabilities.syncAttributes.length}</span>
                    )}
                    {plugin.capabilities.payloadSections.length > 0 && (
                      <span>sections {plugin.capabilities.payloadSections.length}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

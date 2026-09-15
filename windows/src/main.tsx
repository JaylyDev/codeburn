import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { App } from './App'
import { Dock } from './Dock'
import { Settings } from './Settings'
import { applyAccent, savedAccent } from './lib/accent'
import { applyTheme, readSetting } from './lib/settings'
import './styles.css'

// Every window loads the one bundle, so the label decides which surface mounts.
const label = getCurrentWindow().label

// Before the first paint, so nothing tinted by the accent renders in the default ember and
// then jumps. localStorage is the fast cache for both; the file the settings window writes
// is the source of truth and corrects them a round trip later.
applyAccent(savedAccent())
const savedTheme = readSetting('theme')
if (savedTheme === 'dark' || savedTheme === 'light') applyTheme(savedTheme)

function surface() {
  if (label === 'dock') return <Dock />
  if (label === 'settings') return <Settings />
  return <App />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{surface()}</React.StrictMode>
)

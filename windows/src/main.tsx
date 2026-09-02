import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { App } from './App'
import { Dock } from './Dock'
import { applyAccent, savedAccent } from './lib/accent'
import './styles.css'

// Both windows load the one bundle, so the label decides which surface mounts.
const isDock = getCurrentWindow().label === 'dock'

// Before the first paint, so nothing tinted by the accent renders in the default ember and
// then jumps. The dock reads the same tokens.
applyAccent(savedAccent())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isDock ? <Dock /> : <App />}</React.StrictMode>
)

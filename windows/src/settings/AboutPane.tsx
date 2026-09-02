import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

import { Group, Note, Pane, Row } from './controls'
import { ArrowUpRight, FLAME_PATH } from '../components/Icons'

/// The mac's AboutSettingsTab: a brand hero, the version with a Check for Updates button,
/// the three links, and the licence line.

const LINKS = [
  { title: 'GitHub', url: 'https://github.com/getagentseal/codeburn' },
  { title: 'Website', url: 'https://codeburn.app' },
  { title: 'Issues', url: 'https://github.com/getagentseal/codeburn/issues' },
]

export function AboutPane() {
  const [version, setVersion] = useState('')

  useEffect(() => {
    invoke<string>('app_version').then(setVersion).catch(() => {})
  }, [])

  return (
    <Pane>
      <div className="stg-hero">
        <div className="stg-hero-mark" aria-hidden="true">
          <svg width="56" height="56" viewBox="0 0 16 16">
            <path fill="url(#about-flame)" d={FLAME_PATH} />
            <defs>
              <linearGradient id="about-flame" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--ember-glow)" />
                <stop offset="55%" stopColor="var(--brand-accent)" />
                <stop offset="100%" stopColor="var(--ember-deep)" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="stg-hero-name">CodeBurn</div>
        <div className="stg-hero-version">{version ? `Version ${version}` : 'Version'}</div>
        <div className="stg-hero-tagline">Your AI Bill, Itemized</div>
      </div>

      <Group title="Updates">
        <Row
          label={version ? `Version ${version}` : 'Version'}
          control={
            <button type="button" className="btn" disabled title="Not available yet">
              Check for Updates
            </button>
          }
        />
        <Note>
          The in-app update check is not built yet. Until it is, the GitHub releases page below
          lists what is out.
        </Note>
      </Group>

      <Group
        title="Links"
        footer="Copyright 2026 Resham Joshi (iamtoruk) - AgentSeal. MIT License."
      >
        {LINKS.map(link => (
          <button
            key={link.title}
            type="button"
            className="stg-link-row"
            onClick={() => openUrl(link.url)}
          >
            <span className="stg-row-label">{link.title}</span>
            <span className="stg-link-arrow"><ArrowUpRight size={11} /></span>
          </button>
        ))}
      </Group>
    </Pane>
  )
}

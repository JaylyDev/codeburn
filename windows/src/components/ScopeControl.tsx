import { useEffect, useRef, useState } from 'react'
import type { ClaudeConfigOption } from '../lib/payload'
import { CheckIcon, ChevronDown, PersonCircleIcon } from './Icons'

/// Port of ScopeSegmentedControl in mac/.../Views/MenuBarContent.swift. Local is this
/// machine; Combined adds every paired device the CLI can reach. The Claude config picker
/// sits beside it and only appears when the CLI reports more than one config directory.

export type Scope = 'local' | 'combined'

const SCOPES: Array<{ id: Scope; label: string }> = [
  { id: 'local', label: 'Local' },
  { id: 'combined', label: 'Combined' },
]

type Props = {
  scope: Scope
  onScope: (scope: Scope) => void
  configs: ClaudeConfigOption[]
  selectedConfigId: string | null
  onConfig: (id: string | null) => void
}

export function ScopeControl({ scope, onScope, configs, selectedConfigId, onConfig }: Props) {
  return (
    <div className="scope-wrap">
      <nav className="scope-tabs" aria-label="Scope">
        {SCOPES.map(s => (
          <button
            key={s.id}
            type="button"
            className={`period ${scope === s.id ? 'period-active' : ''}`}
            aria-pressed={scope === s.id}
            onClick={() => onScope(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      {configs.length > 1 && (
        <ConfigPicker configs={configs} selectedId={selectedConfigId} onSelect={onConfig} />
      )}
    </div>
  )
}

function ConfigPicker({ configs, selectedId, onSelect }: {
  configs: ClaudeConfigOption[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const label = configs.find(c => c.id === selectedId)?.label ?? 'All'

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (id: string | null) => { onSelect(id); setOpen(false) }

  return (
    <div className="config-picker" ref={ref}>
      <button
        type="button"
        className="config-button"
        title="Claude config"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <PersonCircleIcon size={10} />
        <span className="config-label">{label}</span>
        <ChevronDown size={8} />
      </button>
      {open && (
        <div className="config-menu" role="menu">
          <button type="button" className="config-item" role="menuitem" onClick={() => choose(null)}>
            <span className="config-check">{selectedId === null && <CheckIcon size={9} />}</span>
            All
          </button>
          <div className="config-sep" />
          {configs.map(option => (
            <button
              key={option.id}
              type="button"
              className="config-item"
              role="menuitem"
              title={option.path}
              onClick={() => choose(option.id)}
            >
              <span className="config-check">{selectedId === option.id && <CheckIcon size={9} />}</span>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

import type { CSSProperties, ReactNode } from 'react'

/// The form furniture the settings window is built from, standing in for SwiftUI's
/// `Form(.grouped)`, `Section`, `LabeledContent` and `Picker` in
/// mac/.../Views/SettingsView.swift.

export function Pane({ children }: { children?: ReactNode }) {
  return <div className="stg-pane">{children}</div>
}

export function Group({ id, title, footer, children }: {
  id?: string
  title?: string
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="stg-group" id={id}>
      {title && <h2 className="stg-group-title">{title}</h2>}
      <div className="stg-card">{children}</div>
      {footer && <p className="stg-footer">{footer}</p>}
    </section>
  )
}

export function Row({
  label, hint, control, stacked = false,
}: { label?: ReactNode; hint?: ReactNode; control?: ReactNode; stacked?: boolean }) {
  return (
    <div className={`stg-row ${stacked ? 'stg-row-stacked' : ''}`}>
      <div className="stg-row-text">
        {label && <div className="stg-row-label">{label}</div>}
        {hint && <div className="stg-row-hint">{hint}</div>}
      </div>
      {control && <div className="stg-row-control">{control}</div>}
    </div>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="stg-note">{children}</div>
}

type Option<T> = { id: T; label: string; disabled?: boolean }

/// A native select rather than the popover's DropMenu: this is a resizable window with real
/// window chrome, so the platform control is the honest one and it comes with keyboard
/// handling for free.
export function Select<T extends string | number>({
  value, options, onChange, ariaLabel,
}: { value: T; options: Array<Option<T>>; onChange: (value: T) => void; ariaLabel?: string }) {
  const numeric = typeof value === 'number'
  return (
    <select
      className="stg-select"
      aria-label={ariaLabel}
      value={String(value)}
      onChange={e => onChange((numeric ? Number(e.target.value) : e.target.value) as T)}
    >
      {options.map(option => (
        <option key={String(option.id)} value={String(option.id)} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Switch({ on, disabled = false, onToggle, ariaLabel }: {
  on: boolean
  disabled?: boolean
  onToggle: () => void
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      className={`toggle ${on ? 'toggle-on' : ''}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="toggle-knob" />
    </button>
  )
}

export function Slider({ value, min, max, step, onChange, ariaLabel }: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  ariaLabel?: string
}) {
  // The track is painted here rather than left to the platform: Chromium's own unfilled
  // track came out white on the dark theme, which is the loudest thing in the window.
  const filled = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      className="stg-slider"
      style={{ '--slider-filled': `${filled}%` } as CSSProperties}
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={e => onChange(Number(e.target.value))}
    />
  )
}

export function Field({ value, onChange, placeholder, secure = false, ariaLabel, width }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secure?: boolean
  ariaLabel?: string
  width?: number
}) {
  return (
    <input
      type={secure ? 'password' : 'text'}
      className="stg-field"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      style={width ? { width } : undefined}
      onChange={e => onChange(e.target.value)}
    />
  )
}

import { useState } from 'react'
import { readSetting, writeSetting } from '../lib/settings'
import { StarIcon, XIcon } from './Icons'

const GITHUB_URL = 'https://github.com/getagentseal/codeburn'

export function StarBanner() {
  const [dismissed, setDismissed] = useState(() => readSetting('starBannerDismissed') === 'true')
  if (dismissed) return null

  const dismiss = () => {
    writeSetting('starBannerDismissed', 'true')
    setDismissed(true)
  }

  return (
    <div className="star-banner">
      <StarIcon size={10} className="star-banner-icon" />
      <a className="star-banner-link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
        <span>Enjoying CodeBurn?</span>{' '}
        <span className="star-banner-cta">Star us on GitHub</span>
      </a>
      <span className="star-banner-spacer" />
      <button type="button" className="star-banner-close" onClick={dismiss} title="Hide this banner" aria-label="Hide this banner">
        <XIcon size={9} />
      </button>
    </div>
  )
}

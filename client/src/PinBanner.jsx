import { useEffect, useState } from 'react'

export const PIN_TIPS = [
  'Take clear photos of leaves or flowers for better ID results.',
  'Try photographing the whole plant, not just a single leaf, to improve matches.',
  'Look for native plants nearby and compare them to your catalogue before reporting threats.',
  'A bright, in-focus shot often beats a close-up with poor lighting.',
  'Fresh field notes help when you want to revisit a species later in your catalogue.',
]

const DISMISSED_KEY = 'oregonhacks.pinBannerDismissed'

export default function PinBanner() {
  const [isVisible, setIsVisible] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISSED_KEY) !== '1'
    } catch {
      return true
    }
  })
  const [tip, setTip] = useState(() => {
    const index = Math.floor(Math.random() * PIN_TIPS.length)
    return PIN_TIPS[index]
  })

  useEffect(() => {
    if (!isVisible) {
      try {
        sessionStorage.setItem(DISMISSED_KEY, '1')
      } catch {
        // Storage can fail in private browsing; the component still dismisses in memory.
      }
    }
  }, [isVisible])

  if (!isVisible) return null

  return (
    <div className="pin-banner" role="status" aria-live="polite">
      <div className="pin-banner-inner">
        <img
          className="pin-banner-icon"
          src="./resources/icons8-plant-48.png"
          alt=""
          aria-hidden="true"
        />
        <p>{tip}</p>
        <button
          type="button"
          className="pin-banner-close"
          aria-label="Close tip banner"
          onClick={() => setIsVisible(false)}
        >
          ×
        </button>
      </div>
    </div>
  )
}

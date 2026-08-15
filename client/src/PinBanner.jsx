import { useEffect, useState } from 'react'

// Small set of tips shown in the pinned message. Pick one at random on mount.
const TIPS = [
  'Take clear photos of leaves or flowers for better ID results!',
  'Hold the camera steady and include a close-up of the leaf or flower.',
  'Try to include multiple angles: leaf, stem, and whole plant for best matches.',
  'If outdoors, get a photo with good light and avoid heavy shadows on the plant.',
]

export default function PinBanner() {
  const [tip, setTip] = useState('')
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    // If the user dismissed the banner earlier during this session, keep it hidden.
    const dismissed = sessionStorage.getItem('pinBannerDismissed') === '1'
    if (dismissed) {
      setVisible(false)
      return
    }

    // Choose a random tip on mount
    const idx = Math.floor(Math.random() * TIPS.length)
    setTip(TIPS[idx])
  }, [])

  const close = () => {
    setVisible(false)
    sessionStorage.setItem('pinBannerDismissed', '1')
  }

  if (!visible) return null


  //waiting for image to added to the banner
  return (
    <div className="pin-banner" role="region" aria-label="Tip banner">

      <div className="pin-leaf">🌿</div>
      <div className="pin-text">{tip}</div>
      <button className="pin-close" aria-label="Dismiss tip" onClick={close}>
        ✕
      </button>
    </div>
  )
}

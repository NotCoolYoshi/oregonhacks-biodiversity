import { useEffect, useState } from 'react'

import Intro from '../components/Intro'
import MasonryGallery from '../components/MasonryGallery'

const INTRO_DURATION_MS = 1500

export default function GalleryTest() {
  const [showIntro, setShowIntro] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setShowIntro(false), INTRO_DURATION_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <>
      {showIntro && <Intro durationMs={INTRO_DURATION_MS} />}
      {!showIntro && <MasonryGallery />}
    </>
  )
}

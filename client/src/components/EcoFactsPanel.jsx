import { useState } from 'react'
import { ICON_REFERENCE } from '../iconReference'

// Placeholder trivia, Home-only. Mirrors PIN_TIPS in ./PinBanner.jsx (a
// curated array, one entry shown at a time) but these are general
// biodiversity/plant-ID facts rather than capture-flow guidance, so they live
// in their own array rather than being appended to PIN_TIPS.
export const ECO_FACTS = [
  'Oregon is home to more than 3,700 native plant species, from coastal dunes to high desert sagebrush.',
  'A single native oak can host hundreds of caterpillar species — the food base most backyard birds rely on to raise their young.',
  'Himalayan blackberry, a popular hedge plant, can grow over 20 feet in one season and crowd out native understory in the process.',
  'Roughly 1 in 5 plant species worldwide is currently threatened with extinction, per the IUCN Red List.',
  'A patch of native wildflowers can attract four times as many pollinator species as the same patch of lawn.',
  'Lichens are not a single organism — they are a fungus and an alga (or cyanobacterium) living together as one.',
  'English ivy looks harmless on a fence, but it is classified as a noxious weed in Oregon for smothering native trees.',
  'Some Pacific Northwest old-growth trees have been quietly storing carbon for over 800 years.',
]

/**
 * Static, in-flow eco-facts panel for the Home view. Reuses PinBanner's
 * "one curated string at a time" pattern, but deliberately does not reuse
 * PinBanner itself: it renders inline in Home's normal document flow (no
 * position: fixed, no global mount in App.jsx) and has no dismiss/session
 * persistence, since it's meant to always be there when Home is, not to be
 * cleared once and forgotten like a tip banner.
 */
export default function EcoFactsPanel() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * ECO_FACTS.length))

  const nextFact = () => {
    if (ECO_FACTS.length <= 1) return
    // Re-roll until it lands away from the current fact, so a tap always
    // visibly changes the panel instead of occasionally looking like a no-op.
    setIndex((current) => {
      let next = Math.floor(Math.random() * ECO_FACTS.length)
      while (next === current) next = Math.floor(Math.random() * ECO_FACTS.length)
      return next
    })
  }

  return (
    <section className="eco-facts" aria-live="polite">
      <div className="eco-facts-inner">
        <img className="eco-facts-icon" src={ICON_REFERENCE.plant} alt="" aria-hidden="true" />
        <p>{ECO_FACTS[index]}</p>
        <button
          type="button"
          className="eco-facts-next"
          onClick={nextFact}
          onTouchStart={() => {}}
        >
          Next fact →
        </button>
      </div>
    </section>
  )
}

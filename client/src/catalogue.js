/**
 * Collapse a catch list into one entry per species.
 *
 * Logging the same plant in a second place is a real observation but not a
 * second catalogue entry — the same rule the server applies when it computes
 * uniqueSpeciesCount, so the card count here and the "Owned" figure on the
 * profile agree.
 *
 * Rows arrive newest first, so the retained row (and therefore the type and
 * name shown on the card) is the most recent sighting, while `firstSeen` walks
 * back to the oldest.
 */
export function groupBySpecies(rows) {
  const bySpecies = new Map()

  for (const row of rows) {
    const existing = bySpecies.get(row.taxon_id)
    if (!existing) {
      bySpecies.set(row.taxon_id, { ...row, sightings: 1, firstSeen: row.created_at })
      continue
    }

    existing.sightings += 1
    // Parsed rather than compared as strings: timestamptz can come back with
    // an offset ("+00:00") as well as a "Z", and those two spellings of the
    // same instant do not sort against each other lexicographically.
    if (Date.parse(row.created_at) < Date.parse(existing.firstSeen)) {
      existing.firstSeen = row.created_at
    }
  }

  return [...bySpecies.values()]
}

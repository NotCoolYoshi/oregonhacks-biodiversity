// Mock fixtures shaped like the real downstream responses, so the client can be
// built against these contracts before Pl@ntNet / iNaturalist are wired in.
// Every field here should survive the switch to real data unchanged.

export const IDENTIFY_RESULT = {
  query: { imageCount: 1, organs: ['leaf'] },
  bestMatch: 'Mahonia aquifolium',
  results: [
    {
      score: 0.8734,
      scientificName: 'Mahonia aquifolium',
      genus: 'Mahonia',
      family: 'Berberidaceae',
      commonNames: ['Oregon grape', 'Holly-leaved barberry'],
      gbifId: '3033824',
      inatTaxonId: 57808,
      imageUrl: 'https://example.org/mock/mahonia-aquifolium.jpg',
    },
    {
      score: 0.0912,
      scientificName: 'Mahonia nervosa',
      genus: 'Mahonia',
      family: 'Berberidaceae',
      commonNames: ['Cascade barberry', 'Dwarf Oregon grape'],
      gbifId: '3033841',
      inatTaxonId: 57811,
      imageUrl: 'https://example.org/mock/mahonia-nervosa.jpg',
    },
    {
      score: 0.0201,
      scientificName: 'Ilex aquifolium',
      genus: 'Ilex',
      family: 'Aquifoliaceae',
      commonNames: ['English holly'],
      gbifId: '5414222',
      inatTaxonId: 49572,
      imageUrl: 'https://example.org/mock/ilex-aquifolium.jpg',
    },
  ],
}

// Keyed by iNaturalist taxon id. Anything not listed falls back to UNKNOWN_STATUS.
export const SPECIES_STATUS = {
  57808: {
    taxonId: 57808,
    scientificName: 'Mahonia aquifolium',
    commonName: 'Oregon grape',
    establishmentMeans: 'native',
    isNative: true,
    isInvasive: false,
    conservationStatus: { status: 'LC', statusName: 'least concern', authority: 'IUCN' },
    classification: 'catch',
  },
  49572: {
    taxonId: 49572,
    scientificName: 'Ilex aquifolium',
    commonName: 'English holly',
    establishmentMeans: 'introduced',
    isNative: false,
    isInvasive: true,
    conservationStatus: null,
    classification: 'threat_report',
  },
  54566: {
    taxonId: 54566,
    scientificName: 'Rubus armeniacus',
    commonName: 'Himalayan blackberry',
    establishmentMeans: 'introduced',
    isNative: false,
    isInvasive: true,
    conservationStatus: null,
    classification: 'threat_report',
  },
}

export const UNKNOWN_STATUS = {
  scientificName: null,
  commonName: null,
  establishmentMeans: 'unknown',
  isNative: null,
  isInvasive: false,
  conservationStatus: null,
  classification: 'catch',
}

// Monthly observation counts, Jan..Dec — iNaturalist's `month_of_year` histogram.
export const PHENOLOGY_HISTOGRAM = {
  1: 41, 2: 96, 3: 402, 4: 731, 5: 688, 6: 402,
  7: 233, 8: 187, 9: 154, 10: 121, 11: 74, 12: 38,
}

export const NEARBY_SPECIES = [
  {
    taxonId: 57808,
    scientificName: 'Mahonia aquifolium',
    commonName: 'Oregon grape',
    rank: 'species',
    observationCount: 1284,
    establishmentMeans: 'native',
    isInvasive: false,
    defaultPhotoUrl: 'https://example.org/mock/mahonia-aquifolium-thumb.jpg',
  },
  {
    taxonId: 48472,
    scientificName: 'Pseudotsuga menziesii',
    commonName: 'Douglas fir',
    rank: 'species',
    observationCount: 2140,
    establishmentMeans: 'native',
    isInvasive: false,
    defaultPhotoUrl: 'https://example.org/mock/pseudotsuga-menziesii-thumb.jpg',
  },
  {
    taxonId: 54566,
    scientificName: 'Rubus armeniacus',
    commonName: 'Himalayan blackberry',
    rank: 'species',
    observationCount: 1873,
    establishmentMeans: 'introduced',
    isInvasive: true,
    defaultPhotoUrl: 'https://example.org/mock/rubus-armeniacus-thumb.jpg',
  },
  {
    taxonId: 58732,
    scientificName: 'Cytisus scoparius',
    commonName: 'Scotch broom',
    rank: 'species',
    observationCount: 942,
    establishmentMeans: 'introduced',
    isInvasive: true,
    defaultPhotoUrl: 'https://example.org/mock/cytisus-scoparius-thumb.jpg',
  },
  {
    taxonId: 47602,
    scientificName: 'Acer macrophyllum',
    commonName: 'Bigleaf maple',
    rank: 'species',
    observationCount: 1105,
    establishmentMeans: 'native',
    isInvasive: false,
    defaultPhotoUrl: 'https://example.org/mock/acer-macrophyllum-thumb.jpg',
  },
]

/**
 * Offline names for the handful of places this app was built around.
 *
 * No longer the source of truth: place names come from iNaturalist via
 * getPlaceName() in services/inaturalist.js, because a user can now log a catch
 * anywhere and a three-entry table cannot name Maricopa County. This is what
 * describePlace() in routes/api.js falls back to when that lookup fails, so a
 * region label never blocks a response.
 */
export const PLACES = {
  10: 'Oregon',
  962: 'Lane County, OR',
  2117: 'Multnomah County, OR',
}

export const placeName = (placeId) => PLACES[placeId] ?? `Place ${placeId}`

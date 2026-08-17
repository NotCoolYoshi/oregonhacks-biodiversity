import { useCallback, useEffect, useRef, useState } from 'react'
// Aliased: this component already has a `location` of its own, and it is a
// pair of coordinates rather than a URL.
import { useLocation as useRouterLocation } from 'react-router-dom'

import { identify, getSpeciesStatus, createCatch } from '../api'
import { getUserId } from '../session'
import { compressImage } from '../image'
import { describeIdentifyError, describeSubmitError, describeRetriesExhausted } from '../errors'

/**
 * Pl@ntNet's own accuracy ranking, best first.
 *
 * Reproductive parts are close to diagnostic; leaves are shared across whole
 * genera; bark is the last resort. Users have no reason to know this, hence
 * the hint under the selector — the difference between a flower photo and a
 * bark photo is the difference between a confident match and a shrug.
 *
 * `value` must be one of VALID_ORGANS in server/src/services/plantnet.js —
 * anything else is silently coerced to 'auto' rather than rejected, so a typo
 * here would degrade identification with no error to notice.
 */
const ORGANS = [
  { value: 'flower', label: 'Flower' },
  { value: 'fruit', label: 'Fruit' },
  { value: 'leaf', label: 'Leaf' },
  { value: 'habit', label: 'Entire plant' },
  { value: 'bark', label: 'Bark' },
]

/**
 * Ceiling on the file the user picks, before compression.
 *
 * Compression makes the old 7mb limit (the server's 10mb JSON body, less what
 * base64 adds) unreachable — a 1600px JPEG is a few hundred KB whatever went
 * in. This is now a guard on decoding rather than on uploading: a 100-megapixel
 * image can exhaust memory on a phone before the canvas ever sees it.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024

/**
 * Top-match score at or above which the app commits to a species by itself.
 *
 * Below this the user is asked for a better photo rather than shown a list to
 * pick from: choosing between "59%" and "12%" is a judgement they have no way
 * to make, and a wrong pick is a wrong row in the catalogue.
 */
const CONFIDENCE_THRESHOLD = 0.75

// Photos to ask for before settling for the best result seen. Past this the
// nagging is worse than the imprecision.
const MAX_ATTEMPTS = 5

/**
 * Shown one at a time on the retry screen, advanced by attempt number.
 *
 * Cycled rather than picked at random: rotation cannot repeat itself, and one
 * concrete instruction per retry reads as advice, where a random draw reads as
 * the app stalling.
 */
const RETRY_TIPS = [
  'Try getting closer.',
  'Focus on a single leaf or flower.',
  'Make sure it’s well-lit.',
  'Fill more of the frame with the plant.',
]

/**
 * Identify failures that another photo could plausibly fix.
 *
 * Both are thrown by the server rather than returned (see MIN_CONFIDENCE in
 * server/src/services/plantnet.js), so they arrive as rejections, not as a thin
 * result list — but they mean the same thing as a weak top score and belong on
 * the same retry ladder. Everything else (quota, auth, network) is not the
 * photo's fault and goes straight to the error screen.
 */
const RETRYABLE_CODES = new Set(['LOW_CONFIDENCE', 'NO_MATCH'])

const percent = (score) => `${Math.round((score ?? 0) * 100)}%`

const scoreOf = (candidate) => candidate?.score ?? 0

/**
 * The retry ladder, drawn as a ring.
 *
 * Purely presentational — it reads `attempt` and `total` and decides nothing.
 * The ladder itself (CONFIDENCE_THRESHOLD, MAX_ATTEMPTS, handleWeakAttempt)
 * is untouched by this.
 *
 * The arc is deep green rather than the accent yellow: it is a thin graphical
 * element on the field green, where yellow sits at 1.1:1 and disappears. On the
 * final attempt it turns to the threat orange, so "this is your last photo"
 * arrives as a colour change and not only as a sentence underneath.
 */
const RING_RADIUS = 26
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function AttemptRing({ attempt, total }) {
  const isLast = attempt >= total
  // Guarded so a ratio above 1 could never render a backwards arc.
  const progress = Math.min(attempt / total, 1)

  return (
    <div className={`attempt-ring${isLast ? ' is-last' : ''}`}>
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <circle className="attempt-ring-track" cx="32" cy="32" r={RING_RADIUS} />
        <circle
          className="attempt-ring-arc"
          cx="32"
          cy="32"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
        />
      </svg>
      {/* The number is in the DOM twice on purpose: once visually inside the
          ring, once as a full sentence for screen readers, which get nothing
          useful from "3" on its own. */}
      <span className="attempt-ring-count" aria-hidden="true">
        {attempt}
        <small>/{total}</small>
      </span>
      <span className="sr-only">
        Attempt {attempt} of {total}.
      </span>
    </div>
  )
}

export default function PhotoCapture() {
  const [phase, setPhase] = useState('idle')

  const [organ, setOrgan] = useState('')
  const [photo, setPhoto] = useState(null) // { dataUrl, name, width, height, bytes }
  const [fileError, setFileError] = useState(null)
  const [compressing, setCompressing] = useState(false)

  const [identifySource, setIdentifySource] = useState(null)

  // Retry ladder. All three are per-capture-session and deliberately nowhere
  // near localStorage: navigating away from /capture unmounts this component
  // and takes them with it, which is exactly the intended lifetime.
  const [attempts, setAttempts] = useState(0)
  const [bestCandidate, setBestCandidate] = useState(null)
  const [bestPhoto, setBestPhoto] = useState(null)
  const [retryTip, setRetryTip] = useState(null)

  const [selected, setSelected] = useState(null)
  const [capturedPhoto, setCapturedPhoto] = useState(null)
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState(null)

  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  /**
   * Coordinates handed over by whoever navigated here — currently the map's
   * "go catch this" action on a nearby unknown plant.
   *
   * Read once, on mount, and deliberately not kept in sync with the router:
   * this seeds a capture session, and a session that changed where it thinks it
   * is halfway through would be worse than one that never offered the shortcut.
   */
  const prefill = useRouterLocation().state?.prefill ?? null
  const prefilledLocation =
    prefill?.location &&
    Number.isFinite(Number(prefill.location.lat)) &&
    Number.isFinite(Number(prefill.location.lng))
      ? { lat: Number(prefill.location.lat), lng: Number(prefill.location.lng) }
      : null

  const [location, setLocation] = useState(prefilledLocation)
  const [locationState, setLocationState] = useState(prefilledLocation ? 'prefilled' : 'pending')

  const fileInputRef = useRef(null)

  // Ask for coordinates up front so they are ready by the time a catch is
  // submitted. Never gates anything: denied or unavailable just means the
  // catch is recorded without a location.
  //
  // Skipped entirely when the map already said where this is about. Asking
  // would mean either overwriting the spot the user just tapped or prompting
  // for a permission whose answer we would then throw away — and the pin they
  // chose is the better answer to "which place is this verdict about" anyway,
  // since it is where the plant was actually seen.
  useEffect(() => {
    if (prefilledLocation) return undefined

    if (!navigator.geolocation) {
      setLocationState('unavailable')
      return undefined
    }

    let cancelled = false
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (cancelled) return
        setLocation({ lat: position.coords.latitude, lng: position.coords.longitude })
        setLocationState('ready')
      },
      () => {
        if (!cancelled) setLocationState('unavailable')
      },
      { timeout: 10_000, maximumAge: 300_000 },
    )

    return () => {
      cancelled = true
    }
    // Mount-only: prefilledLocation is derived from router state read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Back to the idle screen for another photo, *without* ending the session.
   *
   * The retry ladder's own state survives on purpose — this is what "attempt 3
   * of 5" is counting, so clearing it here would make the ceiling unreachable
   * and loop forever.
   */
  const clearPhoto = useCallback(() => {
    setPhase('idle')
    setPhoto(null)
    setFileError(null)
    setIdentifySource(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  /** Ends the capture session: everything above, plus the ladder itself. */
  const resetToIdle = useCallback(
    (keepOrgan = true) => {
      clearPhoto()
      setAttempts(0)
      setBestCandidate(null)
      setBestPhoto(null)
      setRetryTip(null)
      setSelected(null)
      setCapturedPhoto(null)
      setStatus(null)
      setStatusError(null)
      setResult(null)
      if (!keepOrgan) setOrgan('')
    },
    [clearPhoto],
  )

  /**
   * Take the picked file down to something worth sending, once.
   *
   * The compressed copy is what everything downstream uses — identification and
   * storage both. Compressing per destination would mean doing it twice and
   * keeping the original in memory in between, for a photo already well above
   * what either needs at 1600px.
   */
  async function onPickFile(event) {
    const file = event.target.files?.[0]
    if (!file) return

    setFileError(null)

    if (file.size > MAX_FILE_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1)
      setFileError(`That photo is ${mb}MB, which is too large to process. Try a smaller one.`)
      setPhoto(null)
      return
    }

    setCompressing(true)
    try {
      // dataUrl is `data:image/jpeg;base64,...`. The prefix carries the content
      // type, which both the identify route and the storage upload read — a
      // bare base64 string would be assumed to be JPEG, and after this it
      // always is, but the server should not have to take that on trust.
      const { dataUrl, width, height, bytes } = await compressImage(file)
      setPhoto({ dataUrl, name: file.name, width, height, bytes })
    } catch (err) {
      setFileError(err.message ?? 'Could not read that file.')
      setPhoto(null)
    } finally {
      setCompressing(false)
    }
  }

  /**
   * An attempt that did not clear the bar: ask for another photo, or stop.
   *
   * `attempt`, `best` and `bestFrom` are passed in rather than read from state
   * — all three are set in the same tick as this runs, and a stale read here
   * would either lose an attempt off the count or discard the result we are
   * about to settle for.
   */
  function handleWeakAttempt(attempt, best, bestFrom) {
    if (attempt < MAX_ATTEMPTS) {
      setRetryTip(RETRY_TIPS[(attempt - 1) % RETRY_TIPS.length])
      setPhase('retry')
      return
    }

    // Out of attempts. Settle for the strongest match seen across the whole
    // session, which is not necessarily the one from the last photo.
    if (best) {
      pickCandidate(best, bestFrom)
      return
    }

    // Every attempt was rejected outright, so there is nothing to settle for.
    setError(describeRetriesExhausted(organ, attempt))
    setPhase('error')
  }

  async function runIdentify() {
    if (!photo || !organ) return

    setPhase('identifying')
    setError(null)

    const attempt = attempts + 1
    setAttempts(attempt)

    try {
      const response = await identify({ imageBase64: photo.dataUrl, organs: [organ] })
      const results = response.results ?? []
      setIdentifySource(response.source ?? null)

      // An empty list is the same outcome as a rejected one, and the server
      // only returns it for mock data — a real Pl@ntNet miss throws NO_MATCH.
      if (results.length === 0) {
        handleWeakAttempt(attempt, bestCandidate, bestPhoto)
        return
      }

      const top = results[0]
      // Which photo produced the running best, tracked in lockstep with the
      // candidate itself. Without it a session that settles for attempt 2's
      // match would file it under attempt 5's photo, and the catalogue would
      // show a picture of a plant that is not the one it names.
      const improved = scoreOf(top) > scoreOf(bestCandidate)
      const best = improved ? top : bestCandidate
      const bestFrom = improved ? photo : bestPhoto
      setBestCandidate(best)
      setBestPhoto(bestFrom)

      if (scoreOf(top) >= CONFIDENCE_THRESHOLD) {
        pickCandidate(top, photo)
        return
      }

      handleWeakAttempt(attempt, best, bestFrom)
    } catch (err) {
      const described = describeIdentifyError(err, organ)

      // LOW_CONFIDENCE and NO_MATCH carry no results with them, so they cost an
      // attempt without ever improving `bestCandidate`.
      if (RETRYABLE_CODES.has(described.code)) {
        handleWeakAttempt(attempt, bestCandidate, bestPhoto)
        return
      }

      setError(described)
      setPhase('error')
    }
  }

  async function pickCandidate(candidate, sourcePhoto) {
    setSelected(candidate)
    // The photo this identification actually came from, which is what gets
    // stored with the catch. Held separately from `photo` because that one is
    // cleared on the way back to the idle screen between retries.
    setCapturedPhoto(sourcePhoto ?? null)
    setStatus(null)
    setStatusError(null)
    setPhase('status-preview')

    try {
      // inatTaxonId is null on every real Pl@ntNet result, so the scientific
      // name is what actually resolves this most of the time — api.js sends
      // it as ?scientific_name= when the id is missing.
      //
      // `location` is what makes this verdict local. Without it the server
      // falls back to a fixed region and reports placeSource: 'fallback',
      // which the verdict block below surfaces rather than hiding.
      setStatus(await getSpeciesStatus(candidate.inatTaxonId, location, candidate.scientificName))
    } catch (err) {
      // Deliberately not an error state. This preview only tells the user what
      // to expect; POST /api/catches recomputes the authoritative type from
      // iNaturalist regardless of what happened here, so a failure costs the
      // user a nice screen, not their catch.
      setStatusError(err?.response?.data?.error ?? 'Could not reach iNaturalist for this species.')
    }
  }

  async function submitCatch() {
    if (!selected) return

    setPhase('submitting')
    setError(null)

    try {
      setResult(
        await createCatch({
          userId: getUserId(),
          // Prefer the id iNaturalist resolved during the preview; fall back to
          // the name and let the server resolve it.
          taxonId: status?.taxonId ?? selected.inatTaxonId ?? undefined,
          scientificName: status?.scientificName ?? selected.scientificName,
          commonName: status?.commonName ?? selected.commonNames?.[0],
          // Pl@ntNet's — iNaturalist's taxon lookup doesn't return one, so
          // there's no server-side value to prefer instead.
          family: selected.family,
          // Omitted when the preview failed: an invented claim would be
          // reported back as `typeCorrected` and confuse the result screen.
          type: status?.classification,
          // No placeId: the server derives the place from these coordinates,
          // which is what keeps the verdict about where the photo was taken.
          ...(location ? { location } : {}),
          // The compressed photo this identification came from. The server
          // uploads it to storage and puts the resulting URL on the row — the
          // client never touches the bucket, and photoUrl is not ours to name.
          ...(capturedPhoto ? { photoBase64: capturedPhoto.dataUrl } : {}),
        }),
      )
      setPhase('result')
    } catch (err) {
      setError(describeSubmitError(err))
      setPhase('error')
    }
  }

  // -------------------------------------------------------------------------

  if (phase === 'identifying' || phase === 'submitting') {
    return (
      <section className="capture">
        <h2>{phase === 'identifying' ? 'Identifying…' : 'Saving…'}</h2>
        {photo && <img className="capture-preview" src={photo.dataUrl} alt="" />}
        <p className="capture-muted">
          {phase === 'identifying'
            ? 'Matching your photo against Pl@ntNet.'
            : 'Recording this in your catalogue.'}
        </p>
      </section>
    )
  }

  if (phase === 'error') {
    return (
      <section className="capture">
        <h2>{error.title}</h2>
        <p>{error.guidance}</p>
        {error.detail && <p className="capture-muted capture-detail">{error.detail}</p>}
        <div className="capture-actions">
          {error.canRetry && (
            <button type="button" onClick={() => resetToIdle()}>
              Try another photo
            </button>
          )}
          <button type="button" className="capture-secondary" onClick={() => resetToIdle()}>
            Start over
          </button>
        </div>
      </section>
    )
  }

  if (phase === 'retry') {
    return (
      <section className="capture">
        <h2>Not confident enough — let’s try another photo</h2>

        {/* The photo being rejected, so the tip below has something to be about.
            Still in state at this point — clearPhoto() only drops it on the way
            back to idle, which is after this screen is gone. */}
        {photo && (
          <img className="capture-preview" src={photo.dataUrl} alt="The photo that could not be identified" />
        )}

        <p className="capture-note">{retryTip}</p>

        <div className="attempt-status">
          <AttemptRing attempt={attempts} total={MAX_ATTEMPTS} />
          {/* The ring carries the count; this carries what the count means,
              which is the part a bare "3/5" cannot say. */}
          <p className="capture-muted">
            {attempts === MAX_ATTEMPTS - 1
              ? 'One more, then we go with the closest match so far.'
              : `${MAX_ATTEMPTS - attempts} left before we go with the closest match so far.`}
          </p>
        </div>

        {bestCandidate && (
          <p className="capture-muted capture-detail">
            Closest so far: <em>{bestCandidate.scientificName}</em> at{' '}
            {percent(bestCandidate.score)}.
          </p>
        )}

        <div className="capture-actions">
          <button type="button" onClick={clearPhoto}>
            Take another photo
          </button>
          <button type="button" className="capture-secondary" onClick={() => resetToIdle()}>
            Start over
          </button>
        </div>
      </section>
    )
  }

  if (phase === 'status-preview') {
    const isThreat = status?.classification === 'threat_report'

    return (
      <section className="capture">
        <h2>
          <em>{selected.scientificName}</em>
        </h2>

        {/* The only screen left that can carry this warning — the candidate
            list it used to live on is gone, and mock data scores high enough
            to come straight here. */}
        {identifySource === 'mock' && (
          <p className="capture-note">
            Showing mock identification data — the server has no PLANTNET_API_KEY set.
          </p>
        )}

        <p className="capture-muted">
          {percent(selected.score)} match
          {selected.family ? ` · ${selected.family}` : ''}
          {attempts > 1 ? ` · best of ${attempts} photos` : ''}
        </p>

        {!status && !statusError && <p className="capture-muted">Checking this species…</p>}

        {status && (
          <div className={`capture-verdict ${isThreat ? 'is-threat' : 'is-native'}`}>
            <strong>{isThreat ? 'Invasive — report this threat' : 'Native — ready to catch'}</strong>
            <p>
              {status.commonName ?? selected.commonNames?.[0] ?? selected.scientificName} is
              recorded as <strong>{status.establishmentMeans}</strong> in {status.placeName}.
            </p>
            {/* The verdict is only meaningful about the region it was read
                from. When we could not work out where the user is, saying so
                is the difference between "not native here" and this app's
                original bug — telling someone in Arizona their palo verde is
                not native to Oregon. */}
            {status.placeSource === 'fallback' && (
              <p className="capture-muted">
                We could not tell where you are, so this was checked against{' '}
                {status.placeName}. Turn on location for a verdict about your own region.
              </p>
            )}
            {status.conservationStatus?.statusName && (
              <p className="capture-muted">
                Conservation status: {status.conservationStatus.statusName}
                {status.conservationStatus.authority
                  ? ` (${status.conservationStatus.authority})`
                  : ''}
              </p>
            )}
          </div>
        )}

        {statusError && (
          <div className="capture-verdict">
            <strong>Could not check this species</strong>
            <p className="capture-muted">{statusError}</p>
            <p>
              You can still log it — the server works out whether it is a catch or a threat
              report when it saves.
            </p>
          </div>
        )}

        <div className="capture-actions">
          <button type="button" onClick={submitCatch} disabled={!status && !statusError}>
            {isThreat ? 'Report this threat' : 'Add to my catalogue'}
          </button>
          {/* Not "back to matches" any more — the user never chose this from a
              list, so there is no previous screen to return to. */}
          <button type="button" className="capture-secondary" onClick={() => resetToIdle()}>
            Start over
          </button>
        </div>
      </section>
    )
  }

  if (phase === 'result') {
    const isThreat = result.type === 'threat_report'

    return (
      <section className="capture">
        <h2>
          {result.isFirstCatch ? '🎉 New species!' : isThreat ? 'Threat reported' : 'Caught!'}
        </h2>

        <div className={`capture-verdict ${isThreat ? 'is-threat' : 'is-native'}`}>
          <strong>
            {result.commonName ?? result.scientificName}
            {result.commonName ? <em> ({result.scientificName})</em> : null}
          </strong>
          <p>
            +{result.pointsAwarded} points
            {result.tier === 'new'
              ? ' — first time you have logged this species.'
              : result.tier === 'repeat_daily'
                ? " — you've caught this one before; today's photo still counts."
                : ' — already logged today, so this one is worth a token amount.'}
          </p>
          {result.streakDays > 1 && (
            <p className="capture-muted">
              {result.streakDays}-day streak
              {result.streakMultiplier > 1 ? ` — ${result.streakMultiplier}x points` : ''}
            </p>
          )}
        </div>

        {result.typeCorrected && (
          <p className="capture-note">
            Logged as a <strong>{isThreat ? 'threat report' : 'catch'}</strong>, not a{' '}
            {result.claimedType === 'threat_report' ? 'threat report' : 'catch'}. iNaturalist
            records it as {result.establishmentMeans} here, and the server goes by that.
          </p>
        )}

        <div className="capture-actions">
          <button type="button" onClick={() => resetToIdle()}>
            Catch another
          </button>
        </div>
      </section>
    )
  }

  // idle
  return (
    <section className="capture">
      <h2>Photo Capture</h2>

      <fieldset className="capture-organs">
        <legend>What are you photographing?</legend>
        <div className="capture-chips">
          {ORGANS.map((option) => (
            <label key={option.value} className={organ === option.value ? 'is-selected' : ''}>
              <input
                type="radio"
                name="organ"
                value={option.value}
                checked={organ === option.value}
                onChange={(event) => setOrgan(event.target.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
        <p className="capture-muted">
          Got a flower or fruit? Those identify far better than a leaf — and a leaf beats bark.
        </p>
      </fieldset>

      <label className="capture-file">
        <span>{photo ? 'Choose a different photo' : 'Take or choose a photo'}</span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPickFile}
        />
      </label>

      {fileError && <p className="capture-note">{fileError}</p>}
      {compressing && <p className="capture-muted">Preparing your photo…</p>}
      {photo && <img className="capture-preview" src={photo.dataUrl} alt="Selected plant" />}

      <div className="capture-actions">
        <button type="button" onClick={runIdentify} disabled={!photo || !organ || compressing}>
          Identify this plant
        </button>
      </div>

      {!organ && photo && <p className="capture-muted">Pick what you photographed first.</p>}

      {/* Where the coordinates came from, always. A prefilled location is the
          one case where the recorded spot is not where the user is standing,
          so it says so rather than presenting a borrowed pin as a fix. */}
      <p className="capture-muted capture-detail">
        {locationState === 'prefilled'
          ? `Using the map pin you tapped (${location.lat.toFixed(3)}, ${location.lng.toFixed(3)})` +
            `${prefill?.commonName || prefill?.scientificName ? ` — where ${prefill.commonName ?? prefill.scientificName} was seen` : ''}.`
          : locationState === 'ready'
            ? `Location ready (${location.lat.toFixed(3)}, ${location.lng.toFixed(3)}).`
            : locationState === 'pending'
              ? 'Asking for your location…'
              : 'No location — your catch will be recorded without coordinates.'}
      </p>
    </section>
  )
}

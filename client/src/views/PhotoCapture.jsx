import { useCallback, useEffect, useRef, useState } from 'react'

import { identify, getSpeciesStatus, createCatch } from '../api'
import { getUserId } from '../session'
import { describeIdentifyError, describeSubmitError, describeRetriesExhausted } from '../errors'

// Every region in this app is Oregon for now. The server defaults to the same
// id, and there is no place picker to build against yet.
const PLACE_ID = 10

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

// The server caps JSON bodies at 10mb and base64 inflates by about a third,
// so anything past ~7mb fails as a body-size error with no useful code on it.
// Catching it here buys a message that names the actual problem.
const MAX_FILE_BYTES = 7 * 1024 * 1024

/**
 * Top-match score at or above which the app commits to a species by itself.
 *
 * Below this the user is asked for a better photo rather than shown a list to
 * pick from: choosing between "59%" and "12%" is a judgement they have no way
 * to make, and a wrong pick is a wrong row in the dex.
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

export default function PhotoCapture() {
  const [phase, setPhase] = useState('idle')

  const [organ, setOrgan] = useState('')
  const [photo, setPhoto] = useState(null) // { dataUrl, name }
  const [fileError, setFileError] = useState(null)

  const [identifySource, setIdentifySource] = useState(null)

  // Retry ladder. All three are per-capture-session and deliberately nowhere
  // near localStorage: navigating away from /capture unmounts this component
  // and takes them with it, which is exactly the intended lifetime.
  const [attempts, setAttempts] = useState(0)
  const [bestCandidate, setBestCandidate] = useState(null)
  const [retryTip, setRetryTip] = useState(null)

  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState(null)

  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const [location, setLocation] = useState(null)
  const [locationState, setLocationState] = useState('pending')

  const fileInputRef = useRef(null)

  // Ask for coordinates up front so they are ready by the time a catch is
  // submitted. Never gates anything: denied or unavailable just means the
  // catch is recorded without a location.
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationState('unavailable')
      return
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
      setRetryTip(null)
      setSelected(null)
      setStatus(null)
      setStatusError(null)
      setResult(null)
      if (!keepOrgan) setOrgan('')
    },
    [clearPhoto],
  )

  function onPickFile(event) {
    const file = event.target.files?.[0]
    if (!file) return

    setFileError(null)

    if (file.size > MAX_FILE_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1)
      setFileError(`That photo is ${mb}MB. The server accepts about 7MB — try a smaller one.`)
      setPhoto(null)
      return
    }

    const reader = new FileReader()
    reader.onerror = () => setFileError('Could not read that file.')
    // readAsDataURL gives `data:image/jpeg;base64,...`. The server strips the
    // prefix and uses the declared type; a bare base64 string would be assumed
    // to be JPEG, which would mislabel a PNG or HEIC.
    reader.onload = () => setPhoto({ dataUrl: String(reader.result), name: file.name })
    reader.readAsDataURL(file)
  }

  /**
   * An attempt that did not clear the bar: ask for another photo, or stop.
   *
   * `attempt` and `best` are passed in rather than read from state — both are
   * set in the same tick as this runs, and a stale read here would either lose
   * an attempt off the count or discard the result we are about to settle for.
   */
  function handleWeakAttempt(attempt, best) {
    if (attempt < MAX_ATTEMPTS) {
      setRetryTip(RETRY_TIPS[(attempt - 1) % RETRY_TIPS.length])
      setPhase('retry')
      return
    }

    // Out of attempts. Settle for the strongest match seen across the whole
    // session, which is not necessarily the one from the last photo.
    if (best) {
      pickCandidate(best)
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
        handleWeakAttempt(attempt, bestCandidate)
        return
      }

      const top = results[0]
      const best = scoreOf(top) > scoreOf(bestCandidate) ? top : bestCandidate
      setBestCandidate(best)

      if (scoreOf(top) >= CONFIDENCE_THRESHOLD) {
        pickCandidate(top)
        return
      }

      handleWeakAttempt(attempt, best)
    } catch (err) {
      const described = describeIdentifyError(err, organ)

      // LOW_CONFIDENCE and NO_MATCH carry no results with them, so they cost an
      // attempt without ever improving `bestCandidate`.
      if (RETRYABLE_CODES.has(described.code)) {
        handleWeakAttempt(attempt, bestCandidate)
        return
      }

      setError(described)
      setPhase('error')
    }
  }

  async function pickCandidate(candidate) {
    setSelected(candidate)
    setStatus(null)
    setStatusError(null)
    setPhase('status-preview')

    try {
      // inatTaxonId is null on every real Pl@ntNet result, so the scientific
      // name is what actually resolves this most of the time — api.js sends
      // it as ?scientific_name= when the id is missing.
      setStatus(await getSpeciesStatus(candidate.inatTaxonId, PLACE_ID, candidate.scientificName))
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
          // Omitted when the preview failed: an invented claim would be
          // reported back as `typeCorrected` and confuse the result screen.
          type: status?.classification,
          placeId: PLACE_ID,
          ...(location ? { location } : {}),
          // No photoUrl — there is no image storage in this app yet.
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
            : 'Recording this in your dex.'}
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

        <p className="capture-muted">
          Attempt {attempts} of {MAX_ATTEMPTS}.{' '}
          {attempts === MAX_ATTEMPTS - 1
            ? 'One more, then we go with the closest match so far.'
            : `${MAX_ATTEMPTS - attempts} left before we go with the closest match so far.`}
        </p>

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
            {isThreat ? 'Report this threat' : 'Add to my dex'}
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
            {result.isFirstCatch
              ? ' — first time you have logged this species.'
              : ' — already in your dex from elsewhere.'}
          </p>
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
      {photo && <img className="capture-preview" src={photo.dataUrl} alt="Selected plant" />}

      <div className="capture-actions">
        <button type="button" onClick={runIdentify} disabled={!photo || !organ}>
          Identify this plant
        </button>
      </div>

      {!organ && photo && <p className="capture-muted">Pick what you photographed first.</p>}

      <p className="capture-muted capture-detail">
        {locationState === 'ready'
          ? `Location ready (${location.lat.toFixed(3)}, ${location.lng.toFixed(3)}).`
          : locationState === 'pending'
            ? 'Asking for your location…'
            : 'No location — your catch will be recorded without coordinates.'}
      </p>
    </section>
  )
}

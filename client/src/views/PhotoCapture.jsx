export default function PhotoCapture() {
  // TODO: file/camera input -> POST /api/identify (multipart or base64),
  // then show candidate matches and let the user confirm one.
  // On confirm: GET /api/species/:taxonId/status?place_id= to decide
  // "catch" vs "threat_report", then POST /api/catches.
  return (
    <section>
      <h2>Photo Capture</h2>
    </section>
  )
}

// Catch photos in Supabase storage.
//
// The client compresses a photo to ~1600px JPEG before it ever leaves the
// browser (see compressImage in client/src/image.js), so what arrives here is
// a few hundred KB rather than a phone camera's several MB. This module does
// the upload and hands back a public URL for the catches row.
//
// Why the server uploads rather than the browser: the client holds no Supabase
// credential at all, and the alternative — handing it the anon key plus an
// insert policy — would let anyone with devtools write to the bucket directly.
// The photo already passes through POST /api/catches; uploading it there costs
// nothing extra and keeps the credential where every other one lives.

import { getSupabase } from '../db/supabaseClient.js'

/** The bucket. Also read by scripts/setup-storage.mjs, which creates it. */
export const PHOTO_BUCKET = 'catch-photos'

/**
 * How the bucket is provisioned. Kept here rather than in the script so the
 * code that uploads and the code that creates the bucket cannot disagree about
 * what it allows.
 *
 * `public: true` — the catalogue renders these by plain <img src>, and there is
 * no auth in this app to scope a signed URL to. The tradeoff is real and small:
 * a photo URL is guessable only if you know a uuid, but it is not access
 * controlled, so this bucket is for plant photos and nothing else.
 *
 * The mime allowlist is deliberately just JPEG. Every path into this bucket
 * re-encodes to JPEG first, so anything else arriving is a bug, and it is
 * better rejected by the bucket than stored.
 */
export const BUCKET_OPTIONS = {
  public: true,
  allowedMimeTypes: ['image/jpeg'],
  // Generous: a compressed catch photo is 150-500KB. This is the ceiling that
  // catches a client that skipped compression, not a target.
  fileSizeLimit: '5MB',
}

// Mirrors the bucket's own allowlist. Checked before upload so a bad payload
// produces our error message rather than a storage API one.
const ACCEPTED_MIME = /^image\/jpeg$/i

/** Uploads that fail for a reason worth telling a caller about. */
export class PhotoStorageError extends Error {
  constructor(message, { status = 502, code = 'PHOTO_UPLOAD_FAILED' } = {}) {
    super(message)
    this.name = 'PhotoStorageError'
    this.status = status
    this.code = code
    this.isPhotoStorageError = true
  }
}

/**
 * Split a `data:image/jpeg;base64,...` URL into its declared type and bytes.
 *
 * The client sends the whole data URL rather than bare base64 for the same
 * reason /api/identify takes one: the prefix is where the content type is
 * declared, and guessing it is how a PNG ends up stored as a .jpg.
 */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl ?? '').trim())

  if (!match) {
    throw new PhotoStorageError(
      'photoBase64 must be a data URL like "data:image/jpeg;base64,...".',
      { status: 400, code: 'BAD_REQUEST' },
    )
  }

  const [, contentType, base64] = match

  if (!ACCEPTED_MIME.test(contentType)) {
    throw new PhotoStorageError(
      `Catch photos must be JPEG (got "${contentType}"). The client re-encodes before upload.`,
      { status: 400, code: 'BAD_REQUEST' },
    )
  }

  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) {
    throw new PhotoStorageError('photoBase64 decoded to an empty file.', {
      status: 400,
      code: 'BAD_REQUEST',
    })
  }

  return { contentType, bytes }
}

/**
 * Object path for one catch's photo.
 *
 * Foldered by user so a single user's photos can be listed or deleted without
 * a scan, and named with a uuid rather than anything derived from the catch —
 * the row does not exist yet when this runs, and a guessable name in a public
 * bucket would let anyone enumerate other people's photos.
 */
const objectPath = (userId) =>
  `${encodeURIComponent(userId)}/${crypto.randomUUID()}.jpg`

/**
 * Upload one catch photo and return its public URL.
 *
 * @param {string} photoBase64 a data:image/jpeg;base64 URL
 * @param {string} userId      the owning user, used only to folder the object
 * @returns {Promise<string>}  public URL to store on the catches row
 */
export async function uploadCatchPhoto(photoBase64, userId) {
  const { contentType, bytes } = decodeDataUrl(photoBase64)
  const path = objectPath(userId)

  const { error } = await getSupabase()
    .storage.from(PHOTO_BUCKET)
    .upload(path, bytes, {
      contentType,
      // Names are uuids, so a collision is not a real case — but an overwrite
      // on one would silently replace another catch's photo, and failing is
      // the better outcome.
      upsert: false,
      // These are immutable once written: a new photo is a new object.
      cacheControl: '31536000',
    })

  if (error) {
    // The bucket not existing is the one failure with an obvious fix, and it
    // is the one a teammate who skipped the setup step will hit.
    if (/bucket not found/i.test(error.message)) {
      throw new PhotoStorageError(
        `The "${PHOTO_BUCKET}" storage bucket does not exist. Run ` +
          '`npm --prefix server run setup:storage`.',
        { status: 500, code: 'BUCKET_MISSING' },
      )
    }
    throw new PhotoStorageError(`Could not store the photo: ${error.message}`)
  }

  const { data } = getSupabase().storage.from(PHOTO_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

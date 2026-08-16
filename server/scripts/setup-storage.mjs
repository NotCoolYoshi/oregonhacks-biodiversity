// Creates the Supabase storage bucket that catch photos live in.
//
//   npm --prefix server run setup:storage
//
// Idempotent: re-running reports the bucket already exists and changes nothing.
//
// This is the one piece of infrastructure the repo provisions for itself. The
// SQL in src/db/ is deliberately applied by hand (there is no migration runner
// — see the header of schema.sql), but a bucket is a single API call against
// the service role key we already hold, and a script is easier to review and
// re-run than a sequence of dashboard clicks to reproduce.

import 'dotenv/config'

import { getSupabase, isConfigured } from '../src/db/supabaseClient.js'
import { PHOTO_BUCKET, BUCKET_OPTIONS } from '../src/services/photoStorage.js'

if (!isConfigured()) {
  console.error(
    'Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env.',
  )
  process.exit(1)
}

const storage = getSupabase().storage

const { data: buckets, error: listError } = await storage.listBuckets()
if (listError) {
  console.error(`Could not list buckets: ${listError.message}`)
  process.exit(1)
}

const existing = buckets.find((bucket) => bucket.name === PHOTO_BUCKET)

if (existing) {
  console.log(`[storage] bucket "${PHOTO_BUCKET}" already exists (public: ${existing.public})`)
  if (!existing.public) {
    console.warn(
      `[storage] WARNING: "${PHOTO_BUCKET}" is private, but the catalogue renders photos by ` +
        'plain URL and will show broken images. Make it public in the Supabase dashboard ' +
        '-> Storage -> Buckets, or delete it and re-run this script.',
    )
  }
  process.exit(0)
}

const { error: createError } = await storage.createBucket(PHOTO_BUCKET, BUCKET_OPTIONS)

if (createError) {
  console.error(`Could not create bucket "${PHOTO_BUCKET}": ${createError.message}`)
  process.exit(1)
}

console.log(`[storage] created bucket "${PHOTO_BUCKET}"`)
console.log(`[storage]   public read:  ${BUCKET_OPTIONS.public}`)
console.log(`[storage]   mime types:   ${BUCKET_OPTIONS.allowedMimeTypes.join(', ')}`)
console.log(`[storage]   max file size: ${BUCKET_OPTIONS.fileSizeLimit}`)
console.log(
  '[storage] Uploads are server-side only (service role). No anonymous write policy exists, ' +
    'and none should be added while the client has no credentials.',
)

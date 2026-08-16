/**
 * Shrink a camera photo before it goes anywhere.
 *
 * A phone camera produces 3-12MB at 4000px on the long edge. Nothing in this
 * app wants that: Pl@ntNet downsamples server-side before identifying, the
 * catalogue renders these into cards a few hundred pixels wide, and every byte
 * is paid for twice — once on the user's upload, once in storage.
 *
 * Canvas only, no dependency. The output is a data URL, which is the shape both
 * POST /api/identify and POST /api/catches already take.
 */

/**
 * Longest edge of the output, in pixels.
 *
 * Comfortably above what identification needs and above what any view in this
 * app renders, so this is a cost decision rather than a quality one — it is the
 * point past which more pixels buy nothing.
 */
const MAX_EDGE = 1600

/** JPEG quality. Past ~0.8 the file grows faster than the picture improves. */
const QUALITY = 0.8

/**
 * Decode a File into something drawable, honouring EXIF orientation.
 *
 * Phone cameras record rotation in EXIF rather than rotating the pixels, and a
 * canvas draws the pixels. Skipping this stores every portrait photo sideways —
 * and permanently, since re-encoding drops the EXIF that would have fixed it on
 * display.
 */
async function decode(file) {
  // The option is what applies the rotation; createImageBitmap ignores EXIF
  // without it.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Older Safari rejects the unknown option rather than ignoring it. Fall
      // through to the <img> path, which browsers orient for us.
    }
  }

  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('That file could not be read as an image.'))
      image.src = url
    })
  } finally {
    // Safe here: drawImage happens after the load resolves, and revoking the
    // URL does not invalidate an already-decoded image.
    URL.revokeObjectURL(url)
  }
}

/** Fit within MAX_EDGE without changing the aspect ratio, never scaling up. */
function fit(width, height) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Resize and re-encode a photo.
 *
 * @param {File} file
 * @returns {Promise<{ dataUrl: string, width: number, height: number, bytes: number }>}
 */
export async function compressImage(file) {
  const source = await decode(file)
  const { width, height } = fit(
    source.width ?? source.naturalWidth,
    source.height ?? source.naturalHeight,
  )

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not process the photo.')

  context.drawImage(source, 0, 0, width, height)
  // ImageBitmaps hold decoded pixels until released, and a few 12-megapixel
  // photos across one capture session is real memory on a phone.
  source.close?.()

  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY)

  if (!dataUrl.startsWith('data:image/jpeg')) {
    // A canvas tainted by a cross-origin source throws instead, so reaching
    // here means the browser refused JPEG and silently gave us PNG — which the
    // storage bucket's mime allowlist would reject on upload.
    throw new Error('This browser could not re-encode the photo as a JPEG.')
  }

  return {
    dataUrl,
    width,
    height,
    // Base64 carries 3 bytes per 4 characters, minus the `data:` prefix.
    bytes: Math.round(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4),
  }
}

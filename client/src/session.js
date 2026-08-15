// Who the current user is, in the absence of any auth.
//
// The server takes `userId` on POST /api/catches and groups the dex and the
// region score by it. There are no accounts yet, so the browser makes one up
// on first use and keeps it in localStorage — a catch made today is still
// yours tomorrow, on this device, in this browser.
//
// This is not a security boundary. Anyone can edit localStorage and claim
// someone else's id; the server does not and cannot verify it. What it does
// buy is a stable identity for the demo. Swap it for auth.uid() when real
// accounts land, and this file is the only place that has to change.

const STORAGE_KEY = 'oregonhacks.userId'

// Keeps the flow working in private-mode Safari and anywhere else storage
// throws, at the cost of the id resetting on reload.
let memoryFallback = null

/** crypto.randomUUID needs a secure context; localhost and https both qualify. */
function newId() {
  if (globalThis.crypto?.randomUUID) return `usr_${globalThis.crypto.randomUUID()}`

  // Good enough to avoid collisions across a hackathon's worth of users.
  const random = Math.random().toString(36).slice(2, 10)
  return `usr_${Date.now().toString(36)}${random}`
}

/**
 * The current user's id, creating and persisting one on first call.
 *
 * Stable for the lifetime of the browser profile. Safe to call from anywhere,
 * as often as you like.
 *
 * @returns {string}
 */
export function getUserId() {
  try {
    const existing = localStorage.getItem(STORAGE_KEY)
    if (existing) return existing

    const created = newId()
    localStorage.setItem(STORAGE_KEY, created)
    return created
  } catch {
    // Storage disabled or full — degrade to a per-session id rather than
    // breaking every view that needs to identify the user.
    memoryFallback ??= newId()
    return memoryFallback
  }
}

/** Forget the current identity. Handy for testing the first-catch flow twice. */
export function resetUserId() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing persisted, nothing to clear */
  }
  memoryFallback = null
}

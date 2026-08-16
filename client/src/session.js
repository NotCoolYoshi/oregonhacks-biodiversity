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
//
// The display name that goes with the id lives in public.users on the server
// (migration 003) and is cached here. The id is the identity; the name is a
// label on it, and losing the cache costs one request, not the account.

import { updateDisplayName } from './api'

const STORAGE_KEY = 'oregonhacks.userId'

// The display name is the server's to generate and ours to cache. Caching it
// is what keeps ensureDisplayName() from hitting the network on every load;
// the id alone is still the identity, and this is only a label.
const NAME_STORAGE_KEY = 'oregonhacks.displayName'

// Keeps the flow working in private-mode Safari and anywhere else storage
// throws, at the cost of the id resetting on reload.
let memoryFallback = null
let nameMemoryFallback = null

// Dedupes the first-load upsert. React runs effects twice in StrictMode, and
// two mounted components both wanting a name would otherwise be two POSTs.
let ensureInFlight = null

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

/**
 * The cached display name, or null if this browser has not been told one yet.
 *
 * Null is not an error state — it just means ensureDisplayName() has not
 * finished (or the server was unreachable when it ran). Callers render a
 * placeholder rather than blocking on it.
 *
 * @returns {string | null}
 */
export function getDisplayName() {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? nameMemoryFallback
  } catch {
    return nameMemoryFallback
  }
}

/**
 * Cache a display name the server has confirmed.
 *
 * Call this after a successful rename so the next load does not have to ask
 * again. It records what the server said, it does not decide anything.
 *
 * @param {string} name
 * @returns {string}
 */
export function setDisplayName(name) {
  nameMemoryFallback = name
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name)
  } catch {
    /* memory fallback already holds it for this session */
  }
  return name
}

/**
 * Make sure this user has a name, asking the server to invent one if not.
 *
 * Runs at most one request per page load: a cached name short-circuits, and
 * concurrent callers share the in-flight promise. The server owns the default
 * ("Explorer 4821"), so the name is the same on every device that ends up with
 * this user id rather than being re-rolled locally.
 *
 * Resolves to null rather than rejecting if the server cannot be reached —
 * being nameless is a worse-looking profile, not a broken one, and the caller
 * has a 'Guest' fallback for exactly this.
 *
 * @returns {Promise<string | null>}
 */
export function ensureDisplayName() {
  const cached = getDisplayName()
  if (cached) return Promise.resolve(cached)

  ensureInFlight ??= updateDisplayName(getUserId())
    .then((user) => (user?.displayName ? setDisplayName(user.displayName) : null))
    .catch(() => null)
    .finally(() => {
      ensureInFlight = null
    })

  return ensureInFlight
}

/** Forget the current identity. Handy for testing the first-catch flow twice. */
export function resetUserId() {
  try {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(NAME_STORAGE_KEY)
  } catch {
    /* nothing persisted, nothing to clear */
  }
  memoryFallback = null
  nameMemoryFallback = null
  ensureInFlight = null
}

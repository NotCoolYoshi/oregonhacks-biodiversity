// Who the current user is.
//
// Prefers a signed-in Clerk identity when one exists; falls back to the
// original anonymous, browser-generated id otherwise. Signed-out browsing
// stays fully functional by design — every read route is open with no auth
// (see server/src/routes/api.js), and this file is what lets them keep
// working exactly as they did before Clerk existed.
//
// getUserId() is the ONE place in this app that answers "who is the current
// user" — every call site (UserProfile, CatalogueView, MapView,
// PhotoCapture) goes through it rather than reading window.Clerk or
// localStorage directly. Read it here before adding a new one.
//
// This is not a security boundary on the anonymous path — anyone can edit
// localStorage and claim someone else's anonymous id, same as always. The
// Clerk path IS one, but only because the server verifies the session JWT
// independently on the two write routes (see
// server/src/middleware/clerkAuth.js); this file reading window.Clerk.user.id
// just picks which id to *ask about*, it proves nothing on its own.
//
// The display name that goes with an id lives in public.users on the server
// and is cached here per-id, so switching identity — signing in, or signing
// into a different account on a shared browser — never shows a name cached
// for someone else.

import { useSyncExternalStore } from 'react'

// Explicit .js extensions here (unlike most imports elsewhere in this
// codebase): this file is also imported directly by plain `node
// test/session.test.mjs` (see that file's header), and bare specifiers only
// resolve under Vite's bundler resolution, not Node's.
import { getCurrentUser, updateDisplayName } from './api.js'
import { hasClerk } from './clerkConfig.js'

const STORAGE_KEY = 'oregonhacks.userId'
const NAME_STORAGE_PREFIX = 'oregonhacks.displayName.'

// globalThis.window / globalThis.localStorage rather than the bare
// identifiers: this app is browser-only and both always exist at runtime,
// but the indirection means a plain Node script can stub them (see
// client/test/session.test.mjs) without a DOM, the same way the rest of this
// codebase's tests stub globalThis.fetch instead of pulling in a browser
// test environment.

// Keeps the flow working in private-mode Safari and anywhere else storage
// throws, at the cost of the id (and cached name) resetting on reload.
let memoryFallbackId = null
const nameMemoryFallback = {} // userId -> name

// Dedupes the first-load upsert per id. React runs effects twice in
// StrictMode, and two mounted components both wanting a name would otherwise
// be two requests; keyed by id so a rapid identity switch (sign-in right
// after landing anonymous) can't have one in-flight request answer for both.
const ensureInFlight = {}

/** crypto.randomUUID needs a secure context; localhost and https both qualify. */
function newAnonymousId() {
  if (globalThis.crypto?.randomUUID) return `usr_${globalThis.crypto.randomUUID()}`

  // Good enough to avoid collisions across a hackathon's worth of users.
  const random = Math.random().toString(36).slice(2, 10)
  return `usr_${Date.now().toString(36)}${random}`
}

/** The browser-generated id, creating and persisting one on first call. */
function getAnonymousUserId() {
  try {
    const existing = globalThis.localStorage.getItem(STORAGE_KEY)
    if (existing) return existing

    const created = newAnonymousId()
    globalThis.localStorage.setItem(STORAGE_KEY, created)
    return created
  } catch {
    // Storage disabled/missing, or full — degrade to a per-session id rather
    // than breaking every view that needs to identify the user.
    memoryFallbackId ??= newAnonymousId()
    return memoryFallbackId
  }
}

/**
 * The signed-in Clerk user's id, or null with no active Clerk session.
 *
 * window.Clerk is the vanilla instance ClerkProvider attaches on mount (see
 * src/ClerkApp.jsx) — reading it directly here, rather than a React hook, is
 * what lets getUserId() serve every kind of call site this app has: a
 * render (UserProfile), an effect (CatalogueView), and a plain event handler
 * (PhotoCapture's submit, MapView's pan-triggered fetch) alike, none of
 * which can call a hook on demand.
 */
function getClerkUserId() {
  return globalThis.window?.Clerk?.user?.id ?? null
}

/**
 * The current user's id: Clerk's, if signed in, else the anonymous
 * localStorage id. The single resolution point every call site in this app
 * goes through — see the file header.
 *
 * Synchronous and safe to call from anywhere, as often as you like. It does
 * NOT by itself notify a caller when the answer changes — a value read once
 * at mount (via useMemo/useState) stays whatever it was at that render, even
 * if the user signs in a moment later once Clerk finishes loading. Render-time
 * call sites should use useCurrentUserId() below instead; call sites that
 * already re-run per user action (a button click, a map pan) are fine
 * calling this directly, since they naturally pick up the current answer
 * every time they fire.
 *
 * @returns {string}
 */
export function getUserId() {
  return getClerkUserId() ?? getAnonymousUserId()
}

function subscribeToClerk(notify) {
  if (!hasClerk) return () => {}

  if (globalThis.window?.Clerk?.addListener) {
    return globalThis.window.Clerk.addListener(() => notify())
  }

  // Clerk's script hasn't attached window.Clerk yet — ClerkApp.jsx's
  // <ClerkProvider> does that once it finishes loading, typically within a
  // few hundred ms of this app mounting. Poll briefly rather than missing
  // that moment and freezing on the anonymous id for the rest of the tab's
  // life; cleared as soon as it appears, or on unmount either way.
  let unsubscribe = () => {}
  const interval = globalThis.setInterval(() => {
    if (!globalThis.window?.Clerk?.addListener) return
    globalThis.clearInterval(interval)
    unsubscribe = globalThis.window.Clerk.addListener(() => notify())
    notify() // Clerk just became available — read its actual state now.
  }, 50)

  return () => {
    globalThis.clearInterval(interval)
    unsubscribe()
  }
}

/**
 * Reactive version of getUserId() for components that read it at render
 * time and need to notice a sign-in/sign-out that happens later — Clerk's
 * initial load finishing after mount, in particular, which otherwise reads
 * as "still anonymous" forever for a component that only checked once.
 *
 * Built on window.Clerk's own change events (see subscribeToClerk) rather
 * than a Clerk React hook: this app already renders UserProfile and
 * CatalogueView whether or not Clerk is configured at all (see hasClerk in
 * src/clerkConfig.js), and Clerk's hooks throw outside a <ClerkProvider> —
 * calling one unconditionally in either component would crash the
 * no-Clerk-key build. useSyncExternalStore has no such requirement.
 *
 * @returns {string}
 */
export function useCurrentUserId() {
  return useSyncExternalStore(subscribeToClerk, getUserId, getUserId)
}

/**
 * A display name Clerk already has for the signed-in user, or undefined.
 *
 * Preference order: fullName (first + last, as Clerk assembles it), then
 * username — some sign-up methods (email-only, some OAuth providers) set
 * neither, which is the undefined case. Passing undefined on to
 * updateDisplayName() is deliberate: POST /api/users already treats "no
 * displayName in the body" as "generate the app's own default", so an
 * unnamed Clerk profile still gets a usable name instead of getting stuck
 * with none.
 *
 * @returns {string | undefined}
 */
function clerkDerivedName() {
  const user = globalThis.window?.Clerk?.user
  return user?.fullName || user?.username || undefined
}

function nameCacheKey(userId) {
  return `${NAME_STORAGE_PREFIX}${userId}`
}

/**
 * The cached display name for `userId`, or null if this browser has not
 * been told one yet for that specific id. Keyed per id on purpose — see the
 * file header on why a shared cache would show a stale name after a sign-in.
 *
 * @param {string} userId
 * @returns {string | null}
 */
export function getDisplayName(userId) {
  try {
    return globalThis.localStorage.getItem(nameCacheKey(userId)) ?? nameMemoryFallback[userId] ?? null
  } catch {
    return nameMemoryFallback[userId] ?? null
  }
}

/**
 * Cache a display name the server has confirmed for `userId`.
 *
 * Call this after a successful rename, or after ensureDisplayName() resolves
 * one, so the next load does not have to ask again. It records what the
 * server said, it does not decide anything.
 *
 * @param {string} userId
 * @param {string} name
 * @returns {string}
 */
export function setDisplayName(userId, name) {
  nameMemoryFallback[userId] = name
  try {
    globalThis.localStorage.setItem(nameCacheKey(userId), name)
  } catch {
    /* memory fallback already holds it for this session */
  }
  return name
}

/**
 * Make sure the current user has a name, asking the server for one — or
 * inventing one from Clerk — if not.
 *
 * Runs at most one request pair (GET, then maybe POST) per id per page
 * load: a cached name short-circuits, and concurrent callers for the same
 * id share the in-flight promise. Once cached, a later call for the same id
 * — including on a future page load, since the cache is localStorage-backed
 * — is free, which is what "once per new sign-in" means in practice: a
 * *new* id (one this browser has not cached a name for yet) is what
 * triggers the check below; the same id on the next render or the next
 * reload is not.
 *
 * The check-before-write matters: POST /api/users overwrites an existing
 * display_name whenever one is given in the body (it's the rename action —
 * see the route's doc comment), so this must never send a Clerk-derived
 * guess for a user who already has a name, whether that name came from an
 * earlier sign-in's guess or from this component's own rename feature. GET
 * first, and only POST a name into the gap where there isn't one yet.
 *
 * `deps` is test-only dependency injection — real callers take the default,
 * which is the actual network calls in ./api. See
 * client/test/session.test.mjs for why this shape rather than mocking the
 * module.
 *
 * @param {{ getCurrentUserFn?: typeof getCurrentUser, updateDisplayNameFn?: typeof updateDisplayName }} [deps]
 * @returns {Promise<string | null>}
 */
export function ensureDisplayName(deps = {}) {
  const { getCurrentUserFn = getCurrentUser, updateDisplayNameFn = updateDisplayName } = deps

  const userId = getUserId()

  const cached = getDisplayName(userId)
  if (cached) return Promise.resolve(cached)

  ensureInFlight[userId] ??= (async () => {
    try {
      const existing = await getCurrentUserFn(userId).catch(() => null)
      if (existing?.displayName) {
        return setDisplayName(userId, existing.displayName)
      }

      // No name on file yet. If Clerk has one, lead with it instead of
      // letting the server invent "Explorer 4821" for someone who already
      // told Clerk their name. undefined (Clerk had neither fullName nor
      // username, or there's no Clerk session at all) falls through to that
      // same server-generated default, unchanged from before Clerk existed.
      const user = await updateDisplayNameFn(userId, clerkDerivedName())
      return user?.displayName ? setDisplayName(userId, user.displayName) : null
    } catch {
      return null
    } finally {
      delete ensureInFlight[userId]
    }
  })()

  return ensureInFlight[userId]
}

/**
 * Forget the anonymous identity. Handy for testing the first-catch flow
 * twice. Does not touch a Clerk session — signing out is Clerk's own
 * <UserButton>'s job, not this function's.
 */
export function resetUserId() {
  try {
    const anonymousId = globalThis.localStorage.getItem(STORAGE_KEY)
    if (anonymousId) {
      globalThis.localStorage.removeItem(nameCacheKey(anonymousId))
      delete nameMemoryFallback[anonymousId]
    }
    globalThis.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing persisted, nothing to clear */
  }
  if (memoryFallbackId) delete nameMemoryFallback[memoryFallbackId]
  memoryFallbackId = null
  for (const key of Object.keys(ensureInFlight)) delete ensureInFlight[key]
}

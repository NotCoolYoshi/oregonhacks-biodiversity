// Auth guard for the two write routes: POST /catches and POST /users.
//
// Everything else stays open — see the "Leave read routes open" note in the
// feature plan this shipped from. Only a route that writes catches.user_id or
// users.user_id needs to know who is actually asking.
//
// requireAuth() from @clerk/express is deliberately NOT used here. As of the
// 2.x line it is deprecated, and — worse for a JSON API — its failure mode is
// `response.redirect(signInUrl)`, which is right for a server-rendered page
// and wrong for a fetch() call that just wants a 401 it can read. This follows
// Clerk's own replacement pattern instead: clerkMiddleware() decorates the
// request, getAuth() reads it, and the 401 is written by hand.

import { clerkMiddleware, getAuth } from '@clerk/express'

/**
 * Whether Clerk is configured at all. Same shape as hasApiKey() in
 * plantnet.js and isConfigured() in supabaseClient.js: a missing key is a
 * setup problem, not a request-time failure, and callers should be able to
 * ask before deciding how to fail.
 */
export function isClerkConfigured() {
  return Boolean(process.env.CLERK_SECRET_KEY)
}

// clerkMiddleware() reads CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY (and, for
// networkless verification, CLERK_JWT_KEY) from process.env itself, fresh on
// every request — building it here does not require any of them to be set
// yet. requireClerkUser() below is what actually enforces that they are.
const attachClerkAuth = clerkMiddleware()

/**
 * Guard middleware for POST /catches and POST /users.
 *
 * Verifies the caller's Clerk session JWT — sent as `Authorization: Bearer
 * <token>`, which is what the client's axios interceptor attaches from
 * Clerk's own getToken() — and sets `req.clerkUserId` to Clerk's userId on
 * success. That value is what the route should write to catches.user_id /
 * users.user_id; it is not read from the request body, for the same reason
 * `type` on POST /catches is not read from the body — a client that could
 * name its own identity could claim someone else's.
 *
 * Answers 503 (not 401) when Clerk itself is unconfigured, mirroring
 * requireDatabase()'s distinction for a missing Supabase config: "this
 * server was never set up for auth" and "you're not signed in" are different
 * failures, and collapsing them would send anyone running without a Clerk
 * key chasing a login bug that isn't one.
 */
export function requireClerkUser(req, res, next) {
  if (!isClerkConfigured()) {
    return res.status(503).json({
      error:
        'Auth is not configured. Set CLERK_SECRET_KEY (and CLERK_PUBLISHABLE_KEY) in server/.env.',
      code: 'AUTH_NOT_CONFIGURED',
    })
  }

  attachClerkAuth(req, res, (err) => {
    if (err) return next(err)

    const auth = getAuth(req)
    if (!auth?.userId) {
      return res.status(401).json({
        error: 'Sign in required.',
        code: 'UNAUTHENTICATED',
      })
    }

    req.clerkUserId = auth.userId
    next()
  })
}

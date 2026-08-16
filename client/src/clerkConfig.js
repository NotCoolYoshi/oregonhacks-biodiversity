// Whether this build has a Clerk publishable key at all.
//
// Shared between ClerkApp.jsx (decides whether to mount <ClerkProvider>) and
// App.jsx (decides whether it's safe to render anything from @clerk/clerk-react
// — those components throw if rendered outside a ClerkProvider, so App.jsx
// checks this before reaching for SignedIn/SignedOut/UserButton rather than
// finding out at render time).
// import.meta.env?. — see the matching note in api.js; this module is also
// reachable from plain `node test/session.test.mjs`, where import.meta.env
// does not exist at all.
export const hasClerk = Boolean(import.meta.env?.VITE_CLERK_PUBLISHABLE_KEY)

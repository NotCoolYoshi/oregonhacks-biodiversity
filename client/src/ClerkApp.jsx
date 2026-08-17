import { ClerkProvider } from '@clerk/clerk-react'

import App from './App'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

/**
 * Wraps <App /> in ClerkProvider, degrading rather than crashing when there
 * is no key to wrap it with — the same "missing config answers plainly"
 * pattern the server uses for Supabase and Pl@ntNet (see requireDatabase()
 * and hasApiKey() in server/src/routes/api.js).
 *
 * Without a key: the app still renders, but nothing inside it can call
 * useAuth()/useUser() or render <SignIn>/<SignUp>/<UserButton> — App.jsx
 * gates those behind hasClerk from this same check (see src/clerkConfig.js).
 * POST /api/catches and POST /api/users will answer 401/503 on every request
 * either way, since the server enforces this independently.
 */
export default function ClerkApp() {
  if (!PUBLISHABLE_KEY) {
    console.warn(
      '[auth] VITE_CLERK_PUBLISHABLE_KEY is not set — sign-in/sign-up are disabled, and ' +
        'POST /api/catches and POST /api/users will reject every request. Add a key from ' +
        'https://dashboard.clerk.com to client/.env to enable auth.',
    )
    return <App />
  }

  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  )
}

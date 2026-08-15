// Supabase client, configured with the SERVICE ROLE key.
//
// ⚠️  SERVER-ONLY. The service role key bypasses Row Level Security — it can
// read and write every row in every table. It must never be imported from
// client/, never sent in a response body, and never exposed through a
// VITE_-prefixed env var (Vite inlines those into the browser bundle).
//
// If you need Supabase access from the browser later, use the anon key with RLS
// policies — not this.

import { createClient } from '@supabase/supabase-js'

let client = null

/** True when both Supabase env vars are present. */
export const isConfigured = () =>
  Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim())

/**
 * Lazily construct the client so importing this module is side-effect free and
 * a missing key fails loudly at call time rather than silently at boot.
 *
 * @throws if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing
 */
export function getSupabase() {
  if (client) return client

  const url = process.env.SUPABASE_URL?.trim()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url || !serviceRoleKey) {
    const missing = [
      !url && 'SUPABASE_URL',
      !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean)

    throw new Error(
      `Supabase is not configured — missing ${missing.join(' and ')} in server/.env. ` +
        'Find both at: Supabase dashboard -> Project Settings -> API. ' +
        'Also make sure src/db/schema.sql has been run in the SQL editor.',
    )
  }

  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return client
}

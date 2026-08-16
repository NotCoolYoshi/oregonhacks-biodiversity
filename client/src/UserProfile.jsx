import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentUser, updateDisplayName } from './api'
import { ensureDisplayName, getUserId, setDisplayName } from './session'

/**
 * The profile header: who you are, and how much of the dex you own.
 *
 * There is no auth, so "current user" is whatever id session.js has in
 * localStorage — it has to be passed to the API explicitly. On first load that
 * id has no row in public.users yet, so ensureDisplayName() runs before the
 * read and lets the server mint a default; without it the header would say
 * 'Guest' until the user renamed themselves by hand.
 *
 * `Owned` is uniqueSpeciesCount, not catchCount: catching the same species in
 * a second region is a real observation and earns points, but it is not a new
 * entry in the dex, and this line is about the dex.
 */
export default function UserProfile() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // Enter and blur can both reach save() for one edit — disabling the input
  // mid-save blurs it in some browsers. A ref settles that synchronously;
  // `saving` state re-renders a frame too late to be the guard.
  const savingRef = useRef(false)

  const load = useCallback(async () => {
    // Establish the row first so the read that follows has a name to return.
    // Resolves to null rather than throwing when the server is unreachable,
    // which leaves the read below to fail on its own terms.
    await ensureDisplayName()
    return getCurrentUser(getUserId())
  }, [])

  useEffect(() => {
    let mounted = true
    load()
      .then((u) => {
        if (mounted) setUser(u)
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => (mounted = false)
  }, [load])

  if (loading) {
    return (
      <div className="user-profile user-profile--loading">
        <div className="avatar avatar--skeleton" />
        <div className="profile-text">
          <div className="skeleton name" />
          <div className="skeleton owned" />
        </div>
      </div>
    )
  }

  // Null when the server could not be reached, or when it has no row for this
  // id yet — both are "we don't know your name", not "your name is Guest".
  const displayName = user?.displayName ?? 'Guest'
  const owned = user?.uniqueSpeciesCount ?? null

  const startEditing = () => {
    setDraft(user?.displayName ?? '')
    setEditing(true)
  }

  const cancelEditing = () => {
    setEditing(false)
    setDraft('')
  }

  const save = async () => {
    if (savingRef.current) return

    const name = draft.trim()
    // The server treats a blank name as "no name given" and keeps the old one,
    // so submitting an empty field is a cancel, not an erasure. Skip the round
    // trip and say so here.
    if (!name || name === user?.displayName) return cancelEditing()

    savingRef.current = true
    setSaving(true)
    try {
      const saved = await updateDisplayName(getUserId(), name)
      if (saved?.displayName) setDisplayName(saved.displayName)
      // Re-read rather than patching state from the response: the totals move
      // independently of the name, and this is the one place that refreshes.
      setUser(await getCurrentUser(getUserId()))
      setEditing(false)
      setDraft('')
    } catch {
      // Leave the field open with what they typed still in it — a failed
      // rename that silently reverts looks like it worked and then undid
      // itself.
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="user-profile">
      <div className="avatar"></div>
      <div className="profile-text">
        {editing ? (
          <input
            className="name name-input"
            value={draft}
            autoFocus
            maxLength={60}
            disabled={saving}
            aria-label="Display name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') cancelEditing()
            }}
          />
        ) : (
          <button className="name name-button" onClick={startEditing} title="Click to rename">
            {displayName}
          </button>
        )}
        <div className="owned">{owned === null ? 'Owned: —' : `Owned: ${owned}`}</div>
      </div>
    </div>
  )
}

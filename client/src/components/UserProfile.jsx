import { useEffect, useMemo, useState } from 'react'
import { updateDisplayName } from '../api'
import { ensureDisplayName, setDisplayName as cacheDisplayName, useCurrentUserId } from '../session'

const DEFAULT_BACKGROUND_SOURCES = Object.values(
  import.meta.glob('../resources/background/*', { eager: true, import: 'default' }),
)

const DEFAULT_AVATAR_SOURCES = Object.values(
  import.meta.glob('../resources/avatar/*', { eager: true, import: 'default' }),
)

function hashString(value) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

export default function UserProfile() {
  // Reactive, not useMemo(() => getUserId(), []): Clerk's own initial load
  // often finishes a beat after this component mounts, and a value frozen at
  // mount would keep showing the anonymous id's profile even after sign-in
  // resolves. See useCurrentUserId() in session.js.
  const userId = useCurrentUserId()
  const [displayName, setDisplayNameState] = useState('')
  const [loading, setLoading] = useState(true)

  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState(null)

  useEffect(() => {
    let active = true
    setLoading(true)

    async function loadProfile() {
      try {
        // ensureDisplayName() already does the GET-then-maybe-POST dance
        // (existing name / Clerk's name / server default, in that order —
        // see its doc comment) and resolves to the name that won. Nothing
        // here needs to re-fetch the profile just to read the same field
        // back.
        const name = await ensureDisplayName()
        if (!active) return
        setDisplayNameState(name || 'Explorer')
      } catch {
        if (active) setDisplayNameState('Explorer')
      } finally {
        if (active) setLoading(false)
      }
    }

    loadProfile()
    return () => {
      active = false
    }
  }, [userId])

  const avatarSrc = useMemo(() => {
    if (DEFAULT_AVATAR_SOURCES.length === 0) return ''
    const index = hashString(userId) % DEFAULT_AVATAR_SOURCES.length
    return DEFAULT_AVATAR_SOURCES[index]
  }, [userId])

  const backgroundSrc = useMemo(() => {
    if (DEFAULT_BACKGROUND_SOURCES.length === 0) return ''
    const index = Math.floor(Math.random() * DEFAULT_BACKGROUND_SOURCES.length)
    return DEFAULT_BACKGROUND_SOURCES[index]
  }, [])

  function startEditing() {
    setRenameError(null)
    setNameDraft(displayName === 'Explorer' ? '' : displayName)
    setEditing(true)
  }

  /**
   * Wired to the rename action POST /api/users already supports (see its
   * doc comment on server/src/routes/api.js) — not a new mechanism.
   *
   * A blank or unchanged draft is a no-op cancel, not an erasure: same rule
   * the server itself applies to a blank displayName, kept consistent here
   * so leaving the field empty and clicking away can never wipe a name.
   */
  async function commitRename() {
    const trimmed = nameDraft.trim()
    setEditing(false)
    if (!trimmed || trimmed === displayName) return

    setRenaming(true)
    setRenameError(null)
    try {
      const user = await updateDisplayName(userId, trimmed)
      if (user?.displayName) {
        setDisplayNameState(user.displayName)
        cacheDisplayName(userId, user.displayName)
      }
    } catch (err) {
      setRenameError(err?.response?.data?.error ?? 'Could not save that name.')
    } finally {
      setRenaming(false)
    }
  }

  function handleNameKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.target.blur() // -> onBlur -> commitRename()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setEditing(false)
    }
  }

  return (
    <div
      className={`user-profile${loading ? ' user-profile--loading' : ''}`}
      style={
        backgroundSrc
          ? {
              backgroundImage: `linear-gradient(rgba(16, 31, 23, 0.22), rgba(16, 31, 23, 0.22)), url(${backgroundSrc})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
            }
          : undefined
      }
    >
      <img
        className={`avatar${loading ? ' avatar--skeleton' : ''}`}
        src={avatarSrc}
        alt={displayName ? `${displayName} avatar` : 'User avatar'}
      />

      <div className="profile-text">
        {loading ? (
          <>
            <div className="skeleton name" aria-hidden="true" />
            <div className="skeleton owned" aria-hidden="true" />
          </>
        ) : (
          <>
            {editing ? (
              <input
                className="name-input"
                autoFocus
                disabled={renaming}
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={handleNameKeyDown}
                onBlur={commitRename}
                maxLength={60}
                aria-label="Display name"
              />
            ) : (
              <button
                type="button"
                className="name-button"
                onClick={startEditing}
                disabled={renaming}
                aria-label={`${displayName}. Click to edit your display name.`}
              >
                {renaming ? 'Saving…' : displayName}
              </button>
            )}
            <div className="owned">Field explorer</div>
            {renameError && (
              <div className="owned" role="alert">
                {renameError}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

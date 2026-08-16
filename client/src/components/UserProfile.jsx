import { useEffect, useMemo, useState } from 'react'
import { getCurrentUser } from '../api'
import { ensureDisplayName, getUserId } from '../session'

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
  const userId = useMemo(() => getUserId(), [])
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    //TODO wait to load database until user has a display name, otherwise the database will be filled with "Explorer" users
    async function loadProfile() {
      try {
        await ensureDisplayName()
        const profile = await getCurrentUser(userId)

        if (!active) return

        const nextName = profile?.displayName || 'Explorer'
        setDisplayName(nextName)
      } catch {
        if (active) setDisplayName('Explorer')
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
            <div className="name">{displayName}</div>
            <div className="owned">Field explorer</div>
          </>
        )}
      </div>
    </div>
  )
}

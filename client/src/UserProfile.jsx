import { useEffect, useMemo, useState } from 'react'
import { getCurrentUser } from './api'
import { ensureDisplayName, getUserId } from './session'

const AVATAR_SOURCES = Object.values(
  import.meta.glob('./resources/avatar/*', { eager: true, import: 'default' }),
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
    if (AVATAR_SOURCES.length === 0) return ''
    const index = hashString(userId) % AVATAR_SOURCES.length
    return AVATAR_SOURCES[index]
  }, [userId])

  return (
    <div className={`user-profile${loading ? ' user-profile--loading' : ''}`}>
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

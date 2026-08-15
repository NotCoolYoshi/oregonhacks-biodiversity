import { useEffect, useState } from 'react'
import { getCurrentUser } from './api'

export default function UserProfile() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    getCurrentUser()
      .then((u) => {
        if (mounted) setUser(u)
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => (mounted = false)
  }, [])

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

  const displayName = user?.name ?? 'Guest'
 //wait for database change to be implemented before displaying owned
  const owned = user?.owned ?? null

  return (
    <div className="user-profile">
      <div className="avatar"></div>
      <div className="profile-text">
        <div className="name">{displayName}</div>
        <div className="owned">{owned === null ? "Owned: —" : `Owned: ${owned}`}</div>
      </div>
    </div>
  )
}

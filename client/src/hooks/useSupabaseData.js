import { useState, useEffect, useCallback } from 'react'
import { getAllSupabaseData, getCatches } from '../api'

/**
 * Custom React hook to fetch all Supabase data (catches, users, counts) from backend.
 *
 * @param {Object} [options]
 * @param {boolean} [options.autoFetch=true] - Whether to fetch automatically on mount
 * @param {number|null} [options.pollInterval=null] - Polling interval in milliseconds (null to disable)
 * @returns {{
 *   data: { catches: Array, users: Array, counts: { catches: number, users: number }, timestamp: string } | null,
 *   catches: Array,
 *   users: Array,
 *   counts: { catches: number, users: number },
 *   loading: boolean,
 *   error: Error | null,
 *   refetch: () => Promise<void>
 * }}
 */
export function useSupabaseData({ autoFetch = true, pollInterval = null } = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(autoFetch)
  const [error, setError] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getAllSupabaseData()
      setData(result)
      return result
    } catch (err) {
      setError(err)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let isMounted = true
    let timerId = null

    if (autoFetch) {
      fetchData().catch(() => {
        // Error state is already stored in state
      })
    }

    if (pollInterval && pollInterval > 0) {
      timerId = setInterval(() => {
        if (isMounted) {
          fetchData().catch(() => {})
        }
      }, pollInterval)
    }

    return () => {
      isMounted = false
      if (timerId) clearInterval(timerId)
    }
  }, [autoFetch, pollInterval, fetchData])

  return {
    data,
    catches: data?.catches ?? [],
    users: data?.users ?? [],
    counts: data?.counts ?? { catches: 0, users: 0 },
    loading,
    error,
    refetch: fetchData,
  }
}

/**
 * Custom React hook to fetch catches data from backend / Supabase.
 *
 * @param {Object} [params] - Optional query params { userId, placeId }
 * @param {Object} [options]
 * @param {boolean} [options.autoFetch=true] - Whether to fetch automatically on mount
 * @returns {{
 *   catches: Array,
 *   loading: boolean,
 *   error: Error | null,
 *   refetch: () => Promise<void>
 * }}
 */
export function useCatches(params = {}, { autoFetch = true } = {}) {
  const [catches, setCatches] = useState([])
  const [loading, setLoading] = useState(autoFetch)
  const [error, setError] = useState(null)

  const fetchCatches = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getCatches(params)
      setCatches(result ?? [])
      return result
    } catch (err) {
      setError(err)
      throw err
    } finally {
      setLoading(false)
    }
  }, [JSON.stringify(params)])

  useEffect(() => {
    if (autoFetch) {
      fetchCatches().catch(() => {})
    }
  }, [autoFetch, fetchCatches])

  return {
    catches,
    loading,
    error,
    refetch: fetchCatches,
  }
}

export default useSupabaseData

import { useEffect, useState } from 'react'
import { getHttpURL } from './config'

export interface SiteLinks {
  termsUrl: string
  privacyUrl: string
}

let cache: { base: string; links: SiteLinks } | null = null

export function useSiteConfig(): SiteLinks {
  const base = getHttpURL()
  const [links, setLinks] = useState<SiteLinks>(
    cache && cache.base === base ? cache.links : { termsUrl: '', privacyUrl: '' },
  )
  useEffect(() => {
    if (!base) return
    let alive = true
    fetch(`${base}/api/site-config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        const next = { termsUrl: c?.termsUrl ?? '', privacyUrl: c?.privacyUrl ?? '' }
        cache = { base, links: next }
        if (alive) setLinks(next)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [base])
  return links
}

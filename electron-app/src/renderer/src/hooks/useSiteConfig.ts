import { useEffect, useState } from 'react'

export interface SiteLinks {
  termsUrl: string
  privacyUrl: string
}

export function useSiteConfig(serverURL?: string): SiteLinks {
  const [links, setLinks] = useState<SiteLinks>({ termsUrl: '', privacyUrl: '' })
  useEffect(() => {
    let alive = true
    window.electronAPI
      .getSiteConfig()
      .then((c) => {
        if (alive) setLinks({ termsUrl: c?.termsUrl ?? '', privacyUrl: c?.privacyUrl ?? '' })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [serverURL])
  return links
}

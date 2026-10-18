import { useQuery } from '@tanstack/react-query';
import { PRODUCT_NAME, type SiteConfig } from 'shared';

const DEFAULT_SITE_CONFIG: SiteConfig = {
  appName: PRODUCT_NAME,
  organizationName: '',
  supportEmail: '',
  termsUrl: '',
  privacyUrl: '',
};

export function useSiteConfig(): SiteConfig {
  const { data } = useQuery<SiteConfig>({
    queryKey: ['site-config'],
    queryFn: async () => {
      const res = await fetch('/api/site-config', { credentials: 'include' });
      if (res.status === 404) return DEFAULT_SITE_CONFIG;
      if (!res.ok) throw new Error(`site-config: HTTP ${res.status}`);
      return { ...DEFAULT_SITE_CONFIG, ...(await res.json()) };
    },
    staleTime: Infinity,
  });
  return data ?? DEFAULT_SITE_CONFIG;
}

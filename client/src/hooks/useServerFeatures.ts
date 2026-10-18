import { useQuery } from '@tanstack/react-query';
import { ALL_FEATURES_ON, type ServerFeatures } from 'shared';
import { useAuth } from './useAuth';

export function useServerFeatures(): ServerFeatures {
  const { user } = useAuth();
  return user?.features ?? ALL_FEATURES_ON;
}

export function usePublicServerFeatures(): ServerFeatures {
  const { data } = useQuery<ServerFeatures>({
    queryKey: ['features'],
    queryFn: async () => {
      const res = await fetch('/api/features');
      if (res.status === 404) return ALL_FEATURES_ON;
      if (!res.ok) throw new Error(`features: HTTP ${res.status}`);
      return { ...ALL_FEATURES_ON, ...(await res.json()) };
    },
    staleTime: Infinity,
  });
  return data ?? ALL_FEATURES_ON;
}

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useSignupStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ['auth', 'signup-status'],
    queryFn: () => api.auth.signupStatus(),
    staleTime: 60_000,
  });
  return { firstAdmin: data?.mode === 'first_admin', isLoading };
}

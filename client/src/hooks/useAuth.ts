import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { api } from '../lib/api';
import type { User } from 'shared';

export function useAuth() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const { data: user, isLoading } = useQuery<User | null>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        return await api.auth.me() as User;
      } catch {
        return null;
      }
    },
    staleTime: 30 * 1000,
  });

  const loginMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      api.auth.login(email, password),
    onSuccess: (data) => {
      qc.setQueryData(['auth', 'me'], data);
      navigate('/');
    },
  });

  const registerMutation = useMutation({
    mutationFn: ({
      email,
      password,
      displayName,
      code,
    }: {
      email: string;
      password: string;
      displayName?: string;
      code?: string;
    }) => api.auth.register(email, password, displayName, code),
    onSuccess: (data) => {
      qc.setQueryData(['auth', 'me'], data);
      navigate('/');
    },
  });

  const googleLoginMutation = useMutation({
    mutationFn: ({ credential, confirmRegistration, code }: { credential: string; confirmRegistration?: boolean; code?: string }) =>
      api.auth.googleLogin(credential, code, confirmRegistration),
    onSuccess: (data) => {
      if ((data as { needsRegistration?: boolean }).needsRegistration === true) return;
      qc.setQueryData(['auth', 'me'], data);
      navigate('/');
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => {
      qc.setQueryData(['auth', 'me'], null);
      qc.clear();
      navigate('/login');
    },
  });

  return {
    user,
    isLoading,
    login: loginMutation.mutateAsync,
    register: registerMutation.mutateAsync,
    resetRegister: registerMutation.reset,
    logout: logoutMutation.mutate,
    googleLogin: googleLoginMutation.mutateAsync,
    resetGoogleLogin: googleLoginMutation.reset,
    loginError: loginMutation.error?.message,
    registerError: registerMutation.error?.message,
    googleLoginError: googleLoginMutation.error?.message,
    isLoginPending: loginMutation.isPending,
    isRegisterPending: registerMutation.isPending,
    isGoogleLoginPending: googleLoginMutation.isPending,
  };
}

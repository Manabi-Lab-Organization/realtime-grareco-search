import { QueryClient, QueryFunction, MutationCache } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { fetchWithReauth } from './reauth';

const defaultQueryFn: QueryFunction = async ({ queryKey }) => {
  const url = queryKey[0] as string;
  const extraParts = queryKey.slice(1);
  const fullUrl = extraParts.length > 0
    ? `${url}/${extraParts.join('/')}`
    : url;

  const res = await fetchWithReauth(fullUrl, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (body.code && body.message) throw new Error(body.message);
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  if (res.status === 204) return null;
  return res.json();
};

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.options.onError) return;
      const description = error instanceof Error ? error.message : String(error);
      toast({
        title: '操作に失敗しました',
        description,
        variant: 'destructive',
      });
    },
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      queryFn: defaultQueryFn,
    },
  },
});

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown
): Promise<Response> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res;
}

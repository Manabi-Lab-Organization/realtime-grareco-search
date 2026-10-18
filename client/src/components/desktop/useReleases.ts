import { useQuery } from "@tanstack/react-query";

export interface ReleaseInfo {
  version: string;
  name: string;
  body: string;
  publishedAt: string | null;
  prerelease: boolean;
}

export function useReleases() {
  return useQuery<ReleaseInfo[]>({
    queryKey: ["/api/releases"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

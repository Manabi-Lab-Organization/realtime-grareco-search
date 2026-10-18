import { useQuery } from "@tanstack/react-query";

interface PlatformAsset {
  url: string;
  size: number;
  filename: string;
}

export interface DownloadInfo {
  available: boolean;
  version?: string;
  mac?: PlatformAsset;
  win?: PlatformAsset;
}

export function useDownloadInfo() {
  return useQuery<DownloadInfo>({
    queryKey: ["/api/download/info"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

import { useMemo } from "react";

export type Platform = "mac" | "win" | "unknown";

export function usePlatformDetect(): Platform {
  return useMemo(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "mac";
    if (ua.includes("win")) return "win";
    return "unknown";
  }, []);
}

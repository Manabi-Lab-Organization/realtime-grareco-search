import { Button } from "@/components/ui/button";
import { Loader2, Download, Apple } from "lucide-react";
import type { DownloadInfo } from "./useDownloadInfo";
import type { Platform } from "./usePlatformDetect";

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}MB`;
}

interface DownloadButtonsProps {
  info: DownloadInfo | undefined;
  isLoading: boolean;
  userPlatform: Platform;
}

export function DownloadButtons({ info, isLoading, userPlatform }: DownloadButtonsProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!info?.available) {
    return (
      <div className="text-center py-4">
        <p className="text-sm text-muted-foreground">
          ダウンロードの準備中です。しばらくお待ちください。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {info.mac ? (
          <a
            href="/api/download/mac"
            className="inline-flex"
          >
            <Button
              variant="outline"
              className="w-full h-auto py-3 flex flex-col items-center gap-1"
            >
              <div className="flex items-center gap-2">
                <Apple className="w-4 h-4" />
                <span className="font-medium">Mac版</span>
              </div>
              <span className="text-xs opacity-70">
                v{info.version} ({formatBytes(info.mac.size)})
              </span>
            </Button>
          </a>
        ) : (
          <Button
            variant="outline"
            className="w-full h-auto py-3 flex flex-col items-center gap-1"
            disabled
          >
            <div className="flex items-center gap-2">
              <Apple className="w-4 h-4" />
              <span className="font-medium">Mac版</span>
            </div>
            <span className="text-xs opacity-70">準備中</span>
          </Button>
        )}

        {info.win ? (
          <a
            href="/api/download/win"
            className="inline-flex"
          >
            <Button
              variant="outline"
              className="w-full h-auto py-3 flex flex-col items-center gap-1"
            >
              <div className="flex items-center gap-2">
                <Download className="w-4 h-4" />
                <span className="font-medium">Windows版</span>
              </div>
              <span className="text-xs opacity-70">
                v{info.version} ({formatBytes(info.win.size)})
              </span>
            </Button>
          </a>
        ) : (
          <Button
            variant="outline"
            className="w-full h-auto py-3 flex flex-col items-center gap-1"
            disabled
          >
            <div className="flex items-center gap-2">
              <Download className="w-4 h-4" />
              <span className="font-medium">Windows版</span>
            </div>
            <span className="text-xs opacity-70">準備中</span>
          </Button>
        )}
      </div>
    </div>
  );
}

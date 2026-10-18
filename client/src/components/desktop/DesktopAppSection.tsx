import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Monitor } from "lucide-react";
import { useDownloadInfo } from "./useDownloadInfo";
import { usePlatformDetect } from "./usePlatformDetect";
import { DownloadButtons } from "./DownloadButtons";
import { SetupGuide } from "./SetupGuide";

export function DesktopAppSection() {
  const { data: downloadInfo, isLoading } = useDownloadInfo();
  const platform = usePlatformDetect();

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Monitor className="w-4 h-4" />
            デスクトップアプリ
          </CardTitle>
          {downloadInfo?.version && (
            <Badge variant="secondary" className="text-xs">
              v{downloadInfo.version}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <DownloadButtons
          info={downloadInfo}
          isLoading={isLoading}
          userPlatform={platform}
        />
        <SetupGuide userPlatform={platform} />
      </CardContent>
    </Card>
  );
}

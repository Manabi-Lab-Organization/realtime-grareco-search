import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink, Smartphone } from "lucide-react";
import { IOS_APP_STORE_URL } from "@/lib/appLinks";

export function IosAppSection() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Smartphone className="w-4 h-4" />
          iPhoneアプリ
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          iPhone で会議を録音・文字起こしするためのアプリです。録音した会議の要約・議事録・グラレコは、このWeb画面で確認できます。
        </p>
        {IOS_APP_STORE_URL ? (
          <a href={IOS_APP_STORE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex">
            <Button variant="outline" className="gap-2">
              App Store で入手
              <ExternalLink className="w-3.5 h-3.5" />
            </Button>
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">App Store での公開を準備しています。</p>
        )}
      </CardContent>
    </Card>
  );
}

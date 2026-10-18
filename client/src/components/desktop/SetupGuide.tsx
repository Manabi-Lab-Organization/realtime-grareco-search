import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import type { Platform } from "./usePlatformDetect";

interface SetupGuideProps {
  userPlatform: Platform;
}

export function SetupGuide({ userPlatform }: SetupGuideProps) {
  const isMac = userPlatform !== "win";

  return (
    <div className="space-y-4">
      <div className="border-t pt-4">
        <h4 className="text-sm font-medium mb-3">セットアップ手順</h4>
        <ol className="space-y-4 text-sm">
          <li className="flex gap-3">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
              1
            </span>
            <div className="flex-1 min-w-0">
              <p className="font-medium">アプリをインストール</p>
              <div className="mt-1.5 space-y-3 text-xs text-muted-foreground">
                {isMac ? (
                  <div className="space-y-2">
                    <a href="/api/download/mac" className="inline-block">
                      <Button variant="outline" size="sm">
                        <Download className="w-3.5 h-3.5 mr-1.5" />
                        Mac版をダウンロード
                      </Button>
                    </a>
                    <p>ダウンロードしたDMGを開き、アプリをApplicationsフォルダにドラッグしてください</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <a href="/api/download/win" className="inline-block">
                      <Button variant="outline" size="sm">
                        <Download className="w-3.5 h-3.5 mr-1.5" />
                        Windows版をダウンロード
                      </Button>
                    </a>
                    <p>ダウンロードしたインストーラーを実行してください</p>
                  </div>
                )}
              </div>
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
              2
            </span>
            <div>
              <p className="font-medium">ログインして接続</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                アプリを起動 → Google または メールアドレスでログイン → 接続完了
              </p>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}

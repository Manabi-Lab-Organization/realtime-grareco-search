import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { DesktopAppSection } from "@/components/desktop/DesktopAppSection";
import { IosAppSection } from "@/components/desktop/IosAppSection";

export default function DownloadPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" />
          ダッシュボードに戻る
        </Link>

        <h1 className="text-2xl font-bold mb-6">アプリ ダウンロード</h1>

        <div className="space-y-4">
          <DesktopAppSection />
          <IosAppSection />
        </div>

        <p className="mt-6 text-sm text-muted-foreground">
          各バージョンの変更点は{' '}
          <Link href="/changelog" className="text-primary underline">更新履歴</Link>
          {' '}をご覧ください。
        </p>
      </div>
    </div>
  );
}

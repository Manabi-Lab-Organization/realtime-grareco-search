import { Download, Loader2 } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { useAccountExport } from './useAccountExport';

export function DataExportCard({ className }: { className?: string }) {
  const { user } = useAuth();
  const { exporting, exportData } = useAccountExport();

  if (!user) return null;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="h-4 w-4" />
          データのダウンロード
        </CardTitle>
        <CardDescription>
          会議の記録（文字起こし・要約・議事録・グラフィックレコーディング）を、
          まとめて ZIP で保存できます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" onClick={exportData} disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          {exporting ? '準備しています…' : 'データをダウンロード'}
        </Button>
      </CardContent>
    </Card>
  );
}

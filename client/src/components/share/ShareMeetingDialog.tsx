import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Copy, QrCode, Loader2, Radio } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { ShareContentSettings, type ExcludedItems } from './ShareContentSettings';

const DEFAULT_SHARED = ['glossary', 'research', 'grareco', 'summary'];

interface ShareState {
  active: boolean;
  live?: boolean;
  token?: string;
  url?: string;
  sharedContents?: string[];
  excludedItems?: ExcludedItems;
}

interface Props {
  meetingId: number;
  isLive: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareMeetingDialog({ meetingId, isLive, open, onOpenChange }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const shareQuery = useQuery<ShareState>({
    queryKey: ['/api/meetings', meetingId, 'share'],
    enabled: open,
  });
  const share = shareQuery.data;
  const url = share?.active ? share.url : undefined;

  const createMutation = useMutation({
    mutationFn: async () => (await apiRequest('POST', `/api/meetings/${meetingId}/share`)).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'share'] }),
  });

  const revokeMutation = useMutation({
    mutationFn: async () => (await apiRequest('DELETE', `/api/meetings/${meetingId}/share`)).json(),
    onSuccess: () => {
      setQrDataUrl(null);
      qc.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'share'] });
      toast({ title: '共有を停止しました' });
    },
  });

  const patchMutation = useMutation({
    mutationFn: async (patch: { sharedContents?: string[]; excludedItems?: ExcludedItems }) =>
      (await apiRequest('PATCH', `/api/meetings/${meetingId}/share`, patch)).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'share'] }),
  });

  useEffect(() => {
    if (!url) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(url, { width: 220, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [url]);

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'URLをコピーしました' });
    } catch {
      toast({ title: 'コピーに失敗しました', variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-4 w-4" />
            ダッシュボードを共有
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            会議の<strong>実施中のみ</strong>、URLを知っている人が
            「用語解説・リアルタイム調査・自動グラレコ・サマリー」を閲覧できます。
            会議が終了すると共有は自動で無効になります。
          </DialogDescription>
        </DialogHeader>

        {!isLive ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            共有は会議の実施中のみ発行できます。
          </p>
        ) : shareQuery.isLoading ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : share?.active && url ? (
          <div className="space-y-3 min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              共有中
            </div>

            {qrDataUrl && (
              <div className="flex justify-center">
                <img
                  src={qrDataUrl}
                  alt="共有URLのQRコード"
                  className="rounded border bg-white p-2 max-w-full h-auto"
                  width={200}
                  height={200}
                />
              </div>
            )}

            <div className="flex items-center gap-2 rounded border bg-muted/50 px-2 py-1.5 min-w-0">
              <span className="text-xs truncate flex-1 min-w-0">{url}</span>
              <button
                onClick={copyUrl}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title="URLをコピー"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>

            <p className="text-[11px] text-muted-foreground">
              ※ 共有内容は閲覧専用です。コピーは可能ですが、全体の一括コピー/ダウンロードはできません。
            </p>

            <div className="border-t pt-3">
              <ShareContentSettings
                meetingId={meetingId}
                sharedContents={share.sharedContents ?? DEFAULT_SHARED}
                excludedItems={share.excludedItems ?? {}}
                busy={patchMutation.isPending}
                onPatch={(patch) => patchMutation.mutate(patch)}
              />
            </div>

            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              onClick={() => revokeMutation.mutate()}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? '停止中...' : '共有を停止'}
            </Button>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <Button
              className="w-full"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? '作成中...' : '共有を開始する'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

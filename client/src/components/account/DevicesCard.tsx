import { Laptop, Loader2, LogOut, Smartphone, KeyRound } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { useConfirm } from '../ui/confirm-dialog';
import { useToast } from '../../hooks/use-toast';
import { api, type LoginDevice } from '../../lib/api';

function deviceLabel(d: LoginDevice): string {
  if (d.deviceName) return d.deviceName;
  if (d.clientType === 'mobile') return 'モバイルアプリ';
  if (d.clientType === 'api') return '外部連携用 API トークン';
  if (d.clientType === 'legacy') return '以前のログイン';
  return 'デスクトップアプリ';
}

function DeviceIcon({ type }: { type: string }) {
  if (type === 'mobile') return <Smartphone className="h-4 w-4 shrink-0" />;
  if (type === 'api') return <KeyRound className="h-4 w-4 shrink-0" />;
  return <Laptop className="h-4 w-4 shrink-0" />;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function DevicesCard() {
  const confirm = useConfirm();
  const { toast } = useToast();
  const devices = useQuery({ queryKey: ['auth-devices'], queryFn: () => api.auth.devices() });

  const revoke = useMutation({
    mutationFn: (id: number) => api.auth.revokeDevice(id),
    onSuccess: () => {
      toast({ title: 'この端末をログアウトしました' });
      void devices.refetch();
    },
    onError: (err) => toast({ title: 'ログアウトできませんでした', description: err instanceof Error ? err.message : String(err), variant: 'destructive' }),
  });

  const logoutOthers = useMutation({
    mutationFn: () => api.auth.logoutOthers(),
    onSuccess: (r) => {
      toast({
        title: '他の端末からログアウトしました',
        description: `アプリ ${r.revokedTokens} 台・ブラウザ ${r.deletedSessions} 件のログインを終了しました。`,
      });
      void devices.refetch();
    },
    onError: (err) => toast({ title: 'ログアウトできませんでした', description: err instanceof Error ? err.message : String(err), variant: 'destructive' }),
  });

  const list = devices.data?.devices ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Laptop className="h-4 w-4" />
          ログイン中の端末
        </CardTitle>
        <CardDescription>
          このアカウントでログインしているアプリの一覧です。心当たりのない端末や、使わなくなった端末はログアウトしてください。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {devices.isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            読み込み中…
          </p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">ログイン中のアプリはありません。</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {list.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                <DeviceIcon type={d.clientType} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {deviceLabel(d)}
                    {d.current && <span className="ml-2 text-xs text-muted-foreground">（この端末）</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    最終利用 {formatDate(d.lastUsedAt)}
                    {d.clientVersion ? `・v${d.clientVersion}` : ''}
                  </p>
                </div>
                {!d.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'この端末をログアウトしますか？',
                        description: `${deviceLabel(d)} では、もう一度ログインが必要になります。`,
                        confirmText: 'ログアウト',
                        destructive: true,
                      });
                      if (ok) revoke.mutate(d.id);
                    }}
                  >
                    ログアウト
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <Button
          variant="outline"
          disabled={logoutOthers.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: '他の端末からログアウトしますか？',
              description: 'いま使っているこのブラウザ以外の、すべてのアプリとブラウザでログアウトします。\n各端末では、もう一度ログインが必要になります。',
              confirmText: '他の端末からログアウト',
              destructive: true,
            });
            if (ok) logoutOthers.mutate();
          }}
        >
          {logoutOthers.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <LogOut className="h-4 w-4 mr-2" />}
          他の端末からログアウト
        </Button>
      </CardContent>
    </Card>
  );
}

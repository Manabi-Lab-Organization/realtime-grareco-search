import { useState } from 'react';
import { Link } from 'wouter';
import { KeyRound, ChevronRight, BookOpen, HelpCircle, Pencil, Loader2 } from 'lucide-react';
import { Layout } from '../components/layout/Layout';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { AccountDeletionCard } from '../components/account/AccountDeletionCard';
import { DataExportCard } from '../components/account/DataExportCard';
import { DevicesCard } from '../components/account/DevicesCard';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/use-toast';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';

const SETTING_ITEMS = [
  { href: '/change-password', icon: KeyRound, title: 'パスワード変更', description: 'ログインパスワード' },
] as const;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
}

function LinkCard({ icon: Icon, title, description }: { icon: typeof KeyRound; title: string; description: string }) {
  return (
    <Card className="h-full transition-colors hover:bg-accent">
      <CardContent className="p-5 flex items-center gap-4">
        <div className="rounded-full bg-primary/10 p-3 shrink-0">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="text-sm text-muted-foreground truncate">{description}</p>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </CardContent>
    </Card>
  );
}

export default function MyPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  if (!user) return null;

  const startEdit = () => {
    setName(user.displayName || '');
    setEditing(true);
  };

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast({ title: 'ユーザー名を入力してください', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.user.updateProfile(trimmed);
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast({ title: 'ユーザー名を更新しました' });
      setEditing(false);
    } catch (err: any) {
      toast({ title: err.message || '更新に失敗しました', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-semibold">マイページ</h1>

        <Card>
          <CardContent className="p-5 space-y-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">ユーザー名</p>
              {editing ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="ユーザー名"
                    maxLength={100}
                    autoFocus
                    className="sm:max-w-xs"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveName} disabled={saving}>
                      {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                      キャンセル
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium truncate">{user.displayName || '未設定'}</span>
                  <Button size="sm" variant="ghost" onClick={startEdit} className="shrink-0">
                    <Pencil className="w-4 h-4 mr-1" />
                    編集
                  </Button>
                </div>
              )}
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">メールアドレス</p>
              <p className="text-sm truncate">{user.email}</p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">登録日</p>
              <p className="text-sm">{formatDate(user.createdAt)}</p>
            </div>
          </CardContent>
        </Card>

        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-2 px-1">設定</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {SETTING_ITEMS.map(({ href, icon, title, description }) => (
              <Link key={href} href={href} className="block">
                <LinkCard icon={icon} title={title} description={description} />
              </Link>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-2 px-1">サポート</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Link href="/guide" className="block">
              <LinkCard icon={BookOpen} title="使い方ガイド" description="入門・詳細ガイド" />
            </Link>
            <Link href="/troubleshooting" className="block">
              <LinkCard icon={HelpCircle} title="よくある質問（FAQ）" description="トラブル解決・問合せ" />
            </Link>
          </div>
        </div>

        <DevicesCard />
        <DataExportCard />
        <AccountDeletionCard />
      </div>
    </Layout>
  );
}

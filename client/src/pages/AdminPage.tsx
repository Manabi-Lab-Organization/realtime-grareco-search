import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Plus, Copy, Trash2, Pause, Play, Eye, EyeOff, Pencil, KeyRound, Link2, ShieldCheck } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Badge } from '../components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { useToast } from '../hooks/use-toast';
import { useAuth } from '../hooks/useAuth';
import { useServerFeatures } from '../hooks/useServerFeatures';
import { api, type Announcement, type AnnouncementSegment } from '../lib/api';
import { AnnouncementsBell } from '../components/announcements/AnnouncementsBell';

type AdminUser = Awaited<ReturnType<typeof api.admin.users>>[number];

const SEGMENT_LABELS: Partial<Record<AnnouncementSegment, string>> = {
  all: '全員',
  admin: '管理者だけ',
};

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              ダッシュボードに戻る
            </Button>
          </Link>
          <h1 className="text-lg font-semibold">管理画面</h1>
          <div className="ml-auto">
            <AnnouncementsBell />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <Tabs defaultValue="users" className="w-full">
          <TabsList>
            <TabsTrigger value="users">利用者</TabsTrigger>
            <TabsTrigger value="invites">招待</TabsTrigger>
            <TabsTrigger value="announcements">お知らせ</TabsTrigger>
            <TabsTrigger value="analytics">利用状況</TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-6">
            <UsersTab />
          </TabsContent>
          <TabsContent value="invites" className="mt-6">
            <InvitesTab />
          </TabsContent>
          <TabsContent value="announcements" className="mt-6">
            <AnnouncementsTab />
          </TabsContent>
          <TabsContent value="analytics" className="mt-6">
            <AnalyticsTab />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function Loading() {
  return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />読み込み中…</div>;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function AnalyticsTab() {
  const { data: overview, isLoading } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.admin.overview(),
  });
  const features = useServerFeatures();

  if (isLoading || !overview) return <Loading />;

  const fmt = (n: number) => (n ?? 0).toLocaleString('ja-JP');
  const featureRows: { label: string; on: boolean; hint: string }[] = [
    { label: 'リアルタイム調査', on: features.research, hint: 'ANTHROPIC_API_KEY（RESEARCH_ENABLED=false で停止）' },
    { label: '手動グラレコ', on: features.grareco, hint: 'GEMINI_API_KEY または OPENAI_API_KEY' },
    { label: '自動グラレコ・グラレコ検索', on: features.autoGrareco, hint: 'GEMINI_API_KEY' },
    { label: 'Google ログイン', on: features.googleLogin, hint: 'GOOGLE_CLIENT_ID' },
    { label: 'メール送信（パスワード再設定メールなど）', on: features.email, hint: 'RESEND_API_KEY' },
    { label: '会議室のカメラ観察', on: features.roomObservation, hint: 'ROOM_OBSERVATION_ENABLED=true' },
  ];

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-2">利用者</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="登録している人" value={fmt(overview.totalUsers)} />
          <StatCard label="新しく登録（7日）" value={fmt(overview.newUsers7d)} />
          <StatCard label="新しく登録（30日）" value={fmt(overview.newUsers30d)} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-2">会議</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="これまで" value={fmt(overview.totalMeetings)} />
          <StatCard label="直近 7 日" value={fmt(overview.meetings7d)} />
          <StatCard label="直近 30 日" value={fmt(overview.meetings30d)} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-2">このサーバで使える機能</h2>
        <div className="border rounded-md divide-y text-sm">
          {featureRows.map((f) => (
            <div key={f.label} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>{f.label}</span>
              <span className="flex items-center gap-2">
                {!f.on && <span className="text-xs text-muted-foreground">必要な設定：{f.hint}</span>}
                {f.on ? <Badge>使える</Badge> : <Badge variant="outline">未設定</Badge>}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user: me } = useAuth();
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [resetResult, setResetResult] = useState<{ email: string; password: string } | null>(null);
  const { data: users, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.admin.users(),
  });

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      api.admin.updateUser(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
    onError: (e) => toast({ title: '変更できませんでした', description: e instanceof Error ? e.message : '', variant: 'destructive' as any }),
  });

  const resetPassword = useMutation({
    mutationFn: (u: AdminUser) => api.admin.resetPassword(u.id).then((r) => ({ email: u.email, password: r.temporaryPassword })),
    onSuccess: (r) => setResetResult(r),
    onError: (e) => toast({ title: '再設定に失敗しました', description: e instanceof Error ? e.message : '', variant: 'destructive' as any }),
  });

  if (isLoading || !users) return <Loading />;

  const isDeleted = (u: AdminUser) => u.email.startsWith('deleted+') && u.email.endsWith('@removed.local');
  const active = users.filter((u) => !isDeleted(u));
  const fmt = (n: number) => (n ?? 0).toLocaleString('ja-JP');

  const toggleRole = (u: AdminUser) => {
    const next = u.role === 'admin' ? 'user' : 'admin';
    const msg = next === 'admin'
      ? `${u.email} を管理者にしますか？\n管理者は、利用者の管理・招待・お知らせができます。`
      : `${u.email} を一般の利用者に戻しますか？`;
    if (confirm(msg)) update.mutate({ id: u.id, data: { role: next } });
  };

  return (
    <>
      <p className="text-sm text-muted-foreground mb-3">
        登録している人は {active.length} 人です。新しい人は「招待」のタブで招待のリンクを作って送ってください。
      </p>
      <div className="border rounded-md overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left p-2 font-medium">名前</th>
              <th className="text-left p-2 font-medium">メールアドレス</th>
              <th className="text-right p-2 font-medium">会議数</th>
              <th className="text-center p-2 font-medium">役割</th>
              <th className="text-left p-2 font-medium">登録日</th>
              <th className="text-right p-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {active.map((u) => (
              <tr key={u.id} className="border-b hover:bg-muted/30">
                <td className="p-2">{u.displayName ?? '—'}</td>
                <td className="p-2">{u.email}</td>
                <td className="p-2 text-right tabular-nums">{fmt(u.meetingCount)}</td>
                <td className="p-2 text-center">
                  <button
                    onClick={() => toggleRole(u)}
                    disabled={me?.id === u.id || update.isPending}
                    className="disabled:cursor-not-allowed"
                    title={me?.id === u.id ? '自分の役割は変えられません' : 'クリックで役割を切り替え'}
                  >
                    {u.role === 'admin'
                      ? <Badge className="gap-1"><ShieldCheck className="h-3 w-3" />管理者</Badge>
                      : <Badge variant="outline">利用者</Badge>}
                  </button>
                </td>
                <td className="p-2 text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString('ja-JP')}</td>
                <td className="p-2 text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    disabled={me?.id === u.id || resetPassword.isPending}
                    onClick={() => {
                      if (confirm(`${u.email} のパスワードを再設定しますか？\n一時パスワードを発行し、この人のログイン中の端末はすべてログアウトします。`)) {
                        resetPassword.mutate(u);
                      }
                    }}
                    title={me?.id === u.id ? '自分のパスワードはマイページで変更してください' : 'パスワードを再設定（一時パスワードを発行）'}
                  >
                    <KeyRound className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10 h-7 px-2"
                    disabled={me?.id === u.id}
                    onClick={() => setDeleteTarget(u)}
                    title={me?.id === u.id ? '自分自身は削除できません' : 'この人を削除'}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!resetResult} onOpenChange={(o) => { if (!o) setResetResult(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>一時パスワードを発行しました</DialogTitle>
            <DialogDescription>
              {resetResult?.email} さんに伝えてください。この画面を閉じると、もう表示できません。
              ログインしたら、マイページでパスワードを変えてもらってください。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded border bg-muted px-3 py-2 font-mono text-base">{resetResult?.password}</code>
            <Button
              variant="outline"
              size="icon"
              onClick={() => resetResult && navigator.clipboard.writeText(resetResult.password).then(() => toast({ title: 'コピーしました' }))}
              title="コピー"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setResetResult(null)}>閉じる</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteUserDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          qc.invalidateQueries({ queryKey: ['admin', 'users'] });
        }}
      />
    </>
  );
}

function DeleteUserDialog({
  target,
  onClose,
  onDeleted,
}: {
  target: AdminUser | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [confirmEmail, setConfirmEmail] = useState('');
  const open = target !== null;

  useEffect(() => {
    if (open) setConfirmEmail('');
  }, [open, target?.id]);

  const deleteUser = useMutation({
    mutationFn: () => api.admin.deleteUser(target!.id, target!.email),
    onSuccess: () => {
      toast({ title: '削除しました' });
      onDeleted();
    },
    onError: (e) =>
      toast({
        title: '削除できませんでした',
        description: e instanceof Error ? e.message : '',
        variant: 'destructive' as any,
      }),
  });

  if (!target) return null;

  const canDelete = confirmEmail.trim() === target.email && !deleteUser.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            利用者を削除
          </DialogTitle>
          <DialogDescription>
            元に戻せません。この人の会議・文字起こし・要約などをすべて削除し、ログインできなくなります。
            同じメールアドレスで、あらためて招待することはできます。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/30 p-3">{target.email}</div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              確認のため、この人のメールアドレスを入力してください
            </label>
            <Input
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder={target.email}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleteUser.isPending}>
            キャンセル
          </Button>
          <Button variant="destructive" disabled={!canDelete} onClick={() => deleteUser.mutate()}>
            {deleteUser.isPending ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />削除中…</> : '削除する'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function inviteLink(code: string): string {
  return `${window.location.origin}/register?code=${encodeURIComponent(code)}`;
}

function InvitesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: codes, isLoading } = useQuery({
    queryKey: ['admin', 'inviteCodes'],
    queryFn: () => api.admin.inviteCodes.list(),
  });

  const [kind, setKind] = useState<'single' | 'shared'>('single');
  const [days, setDays] = useState('14');
  const [note, setNote] = useState('');
  const [justCreated, setJustCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const d = parseInt(days, 10);
      return api.admin.inviteCodes.create({
        maxUses: kind === 'single' ? 1 : null,
        expiresAt: Number.isFinite(d) && d > 0 ? new Date(Date.now() + d * 86_400_000).toISOString() : null,
        note: note.trim() || null,
      }) as Promise<{ code: string }>;
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['admin', 'inviteCodes'] });
      setNote('');
      setJustCreated(inviteLink(created.code));
    },
    onError: (e) => toast({ title: '作れませんでした', description: e instanceof Error ? e.message : '', variant: 'destructive' as any }),
  });

  const update = useMutation({
    mutationFn: ({ code, data }: { code: string; data: Record<string, unknown> }) =>
      api.admin.inviteCodes.update(code, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'inviteCodes'] }),
  });

  const remove = useMutation({
    mutationFn: (code: string) => api.admin.inviteCodes.delete(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'inviteCodes'] }),
  });

  const copyText = (text: string, title: string) => {
    navigator.clipboard.writeText(text).then(() => toast({ title }));
  };

  if (isLoading || !codes) return <Loading />;

  const isExpired = (c: { expiresAt: string | null }) => !!c.expiresAt && new Date(c.expiresAt) < new Date();
  const isUsedUp = (c: { maxUses: number | null; usedCount: number }) => c.maxUses != null && c.usedCount >= c.maxUses;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">招待のリンクを作る</CardTitle>
          <p className="text-sm text-muted-foreground">
            リンクを開いた人は、招待コードが入った状態で登録画面を開けます。メールやチャットで送ってください。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={kind === 'single'} onChange={() => setKind('single')} />
              1人用（1回だけ使える）
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={kind === 'shared'} onChange={() => setKind('shared')} />
              まとめて配る用（何人でも使える）
            </label>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3">
            <div>
              <label className="text-xs text-muted-foreground">使える日数（空欄＝期限なし）</label>
              <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">メモ（誰に送ったか など。任意）</label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="例: 営業部の山田さん" />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              リンクを作る
            </Button>
          </div>
          {justCreated && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
              <code className="flex-1 truncate text-xs">{justCreated}</code>
              <Button size="sm" variant="outline" onClick={() => copyText(justCreated, '招待のリンクをコピーしました')}>
                <Copy className="h-4 w-4 mr-1" />
                コピー
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="border rounded-md overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left p-2 font-medium">メモ</th>
              <th className="text-left p-2 font-medium">種類</th>
              <th className="text-right p-2 font-medium">使った人</th>
              <th className="text-left p-2 font-medium">期限</th>
              <th className="text-center p-2 font-medium">状態</th>
              <th className="text-left p-2 font-medium">作った日</th>
              <th className="text-right p-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {codes.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">招待のリンクはまだありません</td></tr>
            )}
            {codes.map((c) => {
              const usable = c.isActive && !isExpired(c) && !isUsedUp(c);
              return (
                <tr key={c.code} className="border-b hover:bg-muted/30">
                  <td className="p-2 text-xs">{c.note ?? '—'}</td>
                  <td className="p-2 text-xs">{c.maxUses === 1 ? '1人用' : c.maxUses == null ? 'まとめて配る用' : `${c.maxUses}人まで`}</td>
                  <td className="p-2 text-right tabular-nums">{c.usedCount}</td>
                  <td className="p-2 text-xs text-muted-foreground">{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString('ja-JP') : 'なし'}</td>
                  <td className="p-2 text-center">
                    {usable
                      ? <Badge>使える</Badge>
                      : <Badge variant="outline">{!c.isActive ? '止めた' : isExpired(c) ? '期限切れ' : '使い切り'}</Badge>}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString('ja-JP')}</td>
                  <td className="p-2 text-right whitespace-nowrap space-x-1">
                    <Button size="icon" variant="ghost" disabled={!usable} onClick={() => copyText(inviteLink(c.code), '招待のリンクをコピーしました')} title="招待のリンクをコピー">
                      <Link2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => update.mutate({ code: c.code, data: { isActive: !c.isActive } })}
                      title={c.isActive ? '止める（このリンクでは登録できなくなる）' : '使えるように戻す'}
                    >
                      {c.isActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => { if (confirm('この招待のリンクを削除しますか？')) remove.mutate(c.code); }}
                      title="削除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AnnouncementsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: items, isLoading } = useQuery({
    queryKey: ['admin', 'announcements'],
    queryFn: () => api.admin.announcements.list(),
  });

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [important, setImportant] = useState(false);
  const [segment, setSegment] = useState<AnnouncementSegment>('all');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);

  const resetForm = () => {
    setTitle(''); setBody(''); setImportant(false);
    setSegment('all'); setStartsAt(''); setEndsAt('');
    setEditingId(null);
  };

  const toLocalInput = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const startEdit = (a: Announcement) => {
    setEditingId(a.id);
    setTitle(a.title);
    setBody(a.body);
    setImportant(a.important);
    setSegment(a.targetSegment);
    setStartsAt(toLocalInput(a.startsAt));
    setEndsAt(toLocalInput(a.endsAt));
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const create = useMutation({
    mutationFn: (data: {
      title: string; body: string; important?: boolean;
      targetSegment?: AnnouncementSegment; startsAt?: string; endsAt?: string | null;
    }) => api.admin.announcements.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'announcements'] });
      setShowForm(false);
      resetForm();
      toast({ title: 'お知らせを作成しました' });
    },
    onError: (e) => toast({ title: '作成失敗', description: e instanceof Error ? e.message : '', variant: 'destructive' as any }),
  });

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      api.admin.announcements.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'announcements'] }),
    onError: (e) => toast({ title: '更新失敗', description: e instanceof Error ? e.message : '', variant: 'destructive' as any }),
  });

  const saveEdit = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      api.admin.announcements.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'announcements'] });
      setShowForm(false);
      resetForm();
      toast({ title: 'お知らせを更新しました' });
    },
    onError: (e) => toast({ title: '更新失敗', description: e instanceof Error ? e.message : '', variant: 'destructive' as any }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.admin.announcements.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'announcements'] }),
    onError: (e) => toast({ title: '削除失敗', description: e instanceof Error ? e.message : '', variant: 'destructive' as any }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) {
      toast({ title: 'タイトルと本文は必須です', variant: 'destructive' as any });
      return;
    }
    if (editingId != null) {
      saveEdit.mutate({
        id: editingId,
        data: {
          title: title.trim(),
          body: body.trim(),
          important,
          targetSegment: segment,
          ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}),
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        },
      });
      return;
    }
    create.mutate({
      title: title.trim(),
      body: body.trim(),
      important,
      targetSegment: segment,
      startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
    });
  };

  if (isLoading || !items) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />読み込み中…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm text-muted-foreground">
            このサーバーの利用者全員のベルのアイコンに届きます。「重要」にすると、ログインした直後に画面の中央に出ます
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" onClick={() => { if (editingId != null) { resetForm(); setShowForm(true); } else { setShowForm((s) => !s); } }}>
              <Plus className="h-4 w-4 mr-1" />
              新規作成
            </Button>
          </div>
        </div>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editingId != null ? 'お知らせ編集' : 'お知らせ作成'}</CardTitle>
            {editingId != null && (
              <p className="text-xs text-muted-foreground">公開中のお知らせは、保存した時点で利用者の表示も変わります（既読・未読はそのまま）</p>
            )}
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">タイトル</label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 来週から会議の記録はこのアプリに統一します" maxLength={200} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">本文（Markdown 対応）</label>
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="- 変更点1&#10;- 変更点2" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">配信対象</label>
                  <select
                    value={segment}
                    onChange={(e) => setSegment(e.target.value as AnnouncementSegment)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {(Object.keys(SEGMENT_LABELS) as AnnouncementSegment[]).map((s) => (
                      <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} />
                    重要（ログイン時にモーダル表示）
                  </label>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">開始日時（空欄=即時）</label>
                  <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">終了日時（空欄=無期限）</label>
                  <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="ghost" onClick={() => { setShowForm(false); resetForm(); }}>キャンセル</Button>
                <Button type="submit" disabled={create.isPending || saveEdit.isPending}>
                  {(create.isPending || saveEdit.isPending) && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                  {editingId != null ? '保存' : '作成'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left p-2 font-medium">タイトル</th>
              <th className="text-left p-2 font-medium">対象</th>
              <th className="text-center p-2 font-medium">重要</th>
              <th className="text-left p-2 font-medium">期間</th>
              <th className="text-center p-2 font-medium">状態</th>
              <th className="text-left p-2 font-medium">作成日</th>
              <th className="text-right p-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">お知らせがまだありません</td></tr>
            )}
            {items.map((a) => (
              <tr key={a.id} className="border-b hover:bg-muted/30">
                <td className="p-2 max-w-xs truncate" title={a.title}>{a.title}</td>
                <td className="p-2 text-xs text-muted-foreground">{SEGMENT_LABELS[a.targetSegment] ?? a.targetSegment}</td>
                <td className="p-2 text-center">{a.important ? <Badge variant="destructive">重要</Badge> : '—'}</td>
                <td className="p-2 text-xs text-muted-foreground">
                  {new Date(a.startsAt).toLocaleDateString('ja-JP')}
                  {' 〜 '}
                  {a.endsAt ? new Date(a.endsAt).toLocaleDateString('ja-JP') : '∞'}
                </td>
                <td className="p-2 text-center">
                  {a.isPublished ? <Badge>公開</Badge> : <Badge variant="outline">非公開</Badge>}
                </td>
                <td className="p-2 text-xs text-muted-foreground">{new Date(a.createdAt).toLocaleDateString('ja-JP')}</td>
                <td className="p-2 text-right space-x-1">
                  <Button size="icon" variant="ghost" onClick={() => startEdit(a)} title="編集">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => update.mutate({ id: a.id, data: { isPublished: !a.isPublished } })}
                    title={a.isPublished ? '非公開にする' : '公開する'}
                  >
                    {a.isPublished ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`お知らせ「${a.title}」を削除しますか？`)) remove.mutate(a.id);
                    }}
                    title="削除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

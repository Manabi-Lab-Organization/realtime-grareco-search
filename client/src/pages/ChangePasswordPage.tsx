import { useState } from 'react';
import { useLocation } from 'wouter';
import { KeyRound, ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/use-toast';
import { apiRequest } from '../lib/queryClient';

export default function ChangePasswordPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!user) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('新しいパスワードが一致しません');
      return;
    }

    if (newPassword.length < 8) {
      setError('新しいパスワードは8文字以上必要です');
      return;
    }

    if (currentPassword === newPassword) {
      setError('現在のパスワードと同じパスワードは使用できません');
      return;
    }

    setIsSubmitting(true);

    try {
      await apiRequest('POST', '/api/auth/change-password', {
        currentPassword,
        newPassword,
      });
      toast({ title: 'パスワードを変更しました' });
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'エラーが発生しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-lg font-semibold">パスワード変更</h1>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-8">
        <Card>
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <div className="rounded-full bg-primary/10 p-3">
                <KeyRound className="h-6 w-6 text-primary" />
              </div>
            </div>
            <CardTitle>パスワードを変更</CardTitle>
            <CardDescription>
              {user.email} のパスワードを変更します
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {error && (
                <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="currentPassword">
                  現在のパスワード
                </label>
                <Input
                  id="currentPassword"
                  type="password"
                  placeholder="現在のパスワード"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="newPassword">
                  新しいパスワード
                </label>
                <Input
                  id="newPassword"
                  type="password"
                  placeholder="8文字以上"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="confirmPassword">
                  新しいパスワード（確認）
                </label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="もう一度入力"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />変更中...</> : 'パスワードを変更'}
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => navigate('/')}>
                キャンセル
              </Button>
            </CardFooter>
          </form>
        </Card>
      </main>
    </div>
  );
}

import { useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { KeyRound, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { apiRequest } from '../lib/queryClient';

export default function ResetPasswordPage() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const token = params.get('token') || '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <div className="rounded-full bg-destructive/10 p-3">
                <XCircle className="h-6 w-6 text-destructive" />
              </div>
            </div>
            <CardTitle>無効なリンク</CardTitle>
            <CardDescription>
              パスワードリセットのリンクが無効です。もう一度リセットをリクエストしてください。
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Link href="/forgot-password" className="w-full">
              <Button className="w-full">パスワードリセットを再リクエスト</Button>
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('パスワードが一致しません');
      return;
    }

    if (newPassword.length < 8) {
      setError('パスワードは8文字以上必要です');
      return;
    }

    setIsSubmitting(true);

    try {
      await apiRequest('POST', '/api/auth/reset-password', {
        token,
        newPassword,
      });
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'エラーが発生しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <div className="rounded-full bg-primary/10 p-3">
                <CheckCircle className="h-6 w-6 text-primary" />
              </div>
            </div>
            <CardTitle>パスワードをリセットしました</CardTitle>
            <CardDescription>
              新しいパスワードでログインしてください。
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Link href="/login" className="w-full">
              <Button className="w-full">ログイン画面へ</Button>
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <div className="rounded-full bg-primary/10 p-3">
              <KeyRound className="h-6 w-6 text-primary" />
            </div>
          </div>
          <CardTitle>新しいパスワードを設定</CardTitle>
          <CardDescription>
            新しいパスワードを入力してください。8文字以上必要です。
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
                パスワード確認
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
          <CardFooter>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />リセット中...</> : 'パスワードをリセット'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

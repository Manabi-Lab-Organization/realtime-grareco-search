import { useState } from 'react';
import { Link } from 'wouter';
import { Mail, ArrowLeft, CheckCircle, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { apiRequest } from '../lib/queryClient';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      await apiRequest('POST', '/api/auth/forgot-password', { email });
      setSent(true);
    } catch (err: any) {
      setError(err.message || 'エラーが発生しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <div className="rounded-full bg-primary/10 p-3">
                <CheckCircle className="h-6 w-6 text-primary" />
              </div>
            </div>
            <CardTitle>メールを送信しました</CardTitle>
            <CardDescription>
              {email} にパスワードリセットのリンクを送信しました。
              メールをご確認ください。
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col gap-3">
            <p className="text-sm text-center text-muted-foreground">
              メールが届かない場合は、迷惑メールフォルダをご確認ください。
            </p>
            <Link href="/login" className="w-full">
              <Button variant="outline" className="w-full">
                <ArrowLeft className="h-4 w-4 mr-2" />
                ログイン画面に戻る
              </Button>
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
              <Mail className="h-6 w-6 text-primary" />
            </div>
          </div>
          <CardTitle>パスワードをリセット</CardTitle>
          <CardDescription>
            登録したメールアドレスを入力してください。
            パスワードリセットのリンクをお送りします。
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
              <label className="text-sm font-medium" htmlFor="email">
                メールアドレス
              </label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />メール送信中...</> : 'リセットメールを送信'}
            </Button>
            <Link href="/login" className="text-sm text-center text-primary underline">
              ログイン画面に戻る
            </Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

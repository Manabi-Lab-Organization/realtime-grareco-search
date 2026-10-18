import { useState, useEffect, useCallback } from 'react';
import { Link, Redirect } from 'wouter';
import { Loader2 } from 'lucide-react';
import { LogoIcon } from '../components/ui/Logo';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { useAuth } from '../hooks/useAuth';
import { useSignupStatus } from '../hooks/useSignupStatus';
import { usePublicServerFeatures } from '../hooks/useServerFeatures';
import { useSiteConfig } from '../hooks/useSiteConfig';
import { api } from '../lib/api';
import { useConfirm } from '../components/ui/confirm-dialog';
import type { GoogleNeedsRegistrationResponse } from 'shared';
import { resolvePostLoginPath, takeNext } from '@/lib/postLoginRedirect';

function safeNextPath(): string {
  return resolvePostLoginPath({
    search: window.location.search,
    currentPath: '/login',
    stored: takeNext(),
  }) ?? '/';
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: Record<string, unknown>) => void;
          renderButton: (element: HTMLElement, config: Record<string, unknown>) => void;
        };
      };
    };
  }
}

export default function LoginPage() {
  const { appName } = useSiteConfig();
  const { user, isLoading, login, loginError, isLoginPending, googleLogin, googleLoginError, isGoogleLoginPending } = useAuth();
  const confirm = useConfirm();
  const { firstAdmin } = useSignupStatus();
  const { email: canSendEmail } = usePublicServerFeatures();
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleGoogleCallback = useCallback(async (response: { credential: string }) => {
    const result = await googleLogin({ credential: response.credential }).catch(() => null);
    const needs = result as Partial<GoogleNeedsRegistrationResponse> | null;
    if (needs?.needsRegistration === true) {
      const ok = await confirm({
        title: '新規登録の確認',
        description: `このGoogleアカウント（${needs.email}）は未登録です。新規登録しますか？`,
        confirmText: '登録する',
      });
      if (!ok) return;
      await googleLogin({ credential: response.credential, confirmRegistration: true }).catch(() => {});
    }
  }, [googleLogin, confirm]);

  useEffect(() => {
    let mounted = true;
    api.auth.googleClientId().then(({ clientId }) => {
      if (!mounted || !clientId || !window.google) return;
      setGoogleAvailable(true);
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCallback,
      });
      const btnEl = document.getElementById('google-login-btn');
      if (btnEl) {
        window.google.accounts.id.renderButton(btnEl, {
          theme: 'outline',
          size: 'large',
          width: '100%',
          text: 'signin_with',
          locale: 'ja',
        });
      }
    });
    return () => { mounted = false; };
  }, [handleGoogleCallback]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await login({ email, password }).catch(() => {});
  };

  if (!isLoading && user) {
    return <Redirect to={safeNextPath()} />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <LogoIcon className="h-12 w-12" />
          </div>
          <CardTitle>ログイン</CardTitle>
          <CardDescription>{appName} へようこそ</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {(loginError || googleLoginError) && (
              <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                {loginError || googleLoginError}
              </div>
            )}
            <div className="flex justify-center">
              <div id="google-login-btn" />
            </div>
            {isGoogleLoginPending && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />Googleでログイン中...
              </div>
            )}
            {googleAvailable && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">または</span>
                </div>
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
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="password">
                パスワード
              </label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={isLoginPending}>
              {isLoginPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />ログイン中...</> : 'ログイン'}
            </Button>
            {canSendEmail ? (
              <Link href="/forgot-password" className="text-sm text-center text-muted-foreground hover:text-primary underline">
                パスワードをお忘れですか？
              </Link>
            ) : (
              <p className="text-xs text-center text-muted-foreground">
                パスワードを忘れたときは、管理者に一時パスワードの発行を頼んでください。
              </p>
            )}
            {firstAdmin ? (
              <p className="text-sm text-center text-muted-foreground">
                まだ管理者がいません。{' '}
                <Link href="/register" className="text-primary underline">
                  管理者アカウントを作成
                </Link>
              </p>
            ) : (
              <p className="text-xs text-center text-muted-foreground">
                アカウントは、管理者からの招待のリンクで作成します。
              </p>
            )}
            <Link href="/troubleshooting#login" className="text-xs text-center text-muted-foreground hover:text-primary underline">
              ログインでお困りですか？
            </Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

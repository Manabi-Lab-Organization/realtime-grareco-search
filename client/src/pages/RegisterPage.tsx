import { useState, useEffect, useCallback } from 'react';
import { Link } from 'wouter';
import { Loader2 } from 'lucide-react';
import { LogoIcon } from '../components/ui/Logo';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { useAuth } from '../hooks/useAuth';
import { useSignupStatus } from '../hooks/useSignupStatus';
import { api } from '../lib/api';
import { TermsPrivacyLinks, useLegalLinks } from '../components/legal/LegalLinks';

function codeFromUrl(): string {
  return new URLSearchParams(window.location.search).get('code')?.trim() ?? '';
}

export default function RegisterPage() {
  const { register, registerError, isRegisterPending, googleLogin, googleLoginError, isGoogleLoginPending } = useAuth();
  const { firstAdmin, isLoading: statusLoading } = useSignupStatus();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState(codeFromUrl);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const needsAgreement = useLegalLinks().length > 0;
  const [checked, setChecked] = useState(false);
  const agreed = !needsAgreement || checked;
  const canSubmit = agreed && code.trim().length > 0;

  const handleGoogleCallback = useCallback(async (response: { credential: string }) => {
    if (!canSubmit) return;
    await googleLogin({
      credential: response.credential,
      confirmRegistration: true,
      code: code.trim() || undefined,
    }).catch(() => {});
  }, [googleLogin, canSubmit, code]);

  useEffect(() => {
    let mounted = true;
    api.auth.googleClientId().then(({ clientId }) => {
      if (!mounted || !clientId || !window.google) return;
      setGoogleAvailable(true);
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCallback,
      });
      const btnEl = document.getElementById('google-register-btn');
      if (btnEl) {
        btnEl.replaceChildren();
        window.google.accounts.id.renderButton(btnEl, {
          theme: 'outline',
          size: 'large',
          width: '100%',
          text: 'signup_with',
          locale: 'ja',
        });
      }
    }).catch(() => {});
    return () => { mounted = false; };
  }, [handleGoogleCallback]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await register({
      email,
      password,
      displayName: displayName || undefined,
      code: code.trim() || undefined,
    }).catch(() => {});
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <LogoIcon className="h-12 w-12" />
          </div>
          <CardTitle>{firstAdmin ? '管理者アカウントの作成' : '新規登録'}</CardTitle>
          <CardDescription>
            {statusLoading
              ? 'アカウントを作成してください'
              : firstAdmin
                ? 'まだ誰も登録していません。サーバに設定した管理者のメールアドレスと、サーバのログに出ている初期設定コードで登録すると、管理者になります。'
                : '管理者から届いた招待のリンクから登録してください。'}
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {(registerError || googleLoginError) && (
              <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                {registerError || googleLoginError}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="inviteCode">
                {firstAdmin ? '初期設定コード' : '招待コード'}
              </label>
              <Input
                id="inviteCode"
                type="text"
                placeholder={firstAdmin ? 'サーバのログに出ています' : '招待のリンクに含まれています'}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoComplete="off"
              />
            </div>
            {needsAgreement && (
              <label className="flex items-start gap-2 text-sm text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                  className="h-4 w-4 mt-0.5 shrink-0"
                  aria-label="利用規約・プライバシーポリシーに同意する"
                />
                <span><TermsPrivacyLinks />に同意する</span>
              </label>
            )}
            <div
              className={`flex justify-center ${canSubmit ? '' : 'pointer-events-none opacity-50'}`}
              title={canSubmit ? undefined : firstAdmin ? '先に初期設定コードの入力（と規約への同意）が必要です' : '先に招待コードの入力（と規約への同意）が必要です'}
            >
              <div id="google-register-btn" />
            </div>
            {isGoogleLoginPending && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />Googleで登録中...
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
              <label className="text-sm font-medium" htmlFor="displayName">
                名前（任意）
              </label>
              <Input
                id="displayName"
                type="text"
                placeholder="山田 太郎"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
              />
            </div>
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
                パスワード（8文字以上）
              </label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={isRegisterPending || !canSubmit}>
              {isRegisterPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />登録中...</> : 'アカウントを作成'}
            </Button>
            <p className="text-sm text-center text-muted-foreground">
              すでにアカウントをお持ちの方は{' '}
              <Link href="/login" className="text-primary underline">
                ログイン
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

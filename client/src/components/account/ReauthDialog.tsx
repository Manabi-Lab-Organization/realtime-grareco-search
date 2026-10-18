import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { setReauthHandler } from '../../lib/reauth';

export function ReauthDialog() {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<'password' | 'google'>('password');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  const googleBtnRef = useRef<HTMLDivElement | null>(null);

  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    setPassword('');
    setError(null);
    setPending(false);
    resolve?.(ok);
  }, []);

  const submit = useCallback(
    async (payload: { password?: string; credential?: string }) => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch('/api/auth/sudo', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          settle(true);
          return;
        }
        const body = await res.json().catch(() => ({}));
        setError(body.message || '本人確認できませんでした');
      } catch {
        setError('通信に失敗しました。もう一度お試しください');
      }
      setPending(false);
    },
    [settle],
  );

  useEffect(() => {
    setReauthHandler(async () => {
      try {
        const res = await fetch('/api/auth/sudo', { credentials: 'include' });
        const body = res.ok ? await res.json() : {};
        setMethod(body.method === 'google' ? 'google' : 'password');
      } catch {
        setMethod('password');
      }
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        setOpen(true);
      });
    });
    return () => setReauthHandler(null);
  }, []);

  useEffect(() => {
    if (!open || method !== 'google') return;
    let cancelled = false;
    fetch('/api/auth/google/client-id', { credentials: 'include' })
      .then((r) => r.json())
      .then(({ clientId }: { clientId?: string }) => {
        if (cancelled || !clientId || !window.google || !googleBtnRef.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response: { credential?: string }) => {
            if (response.credential) void submit({ credential: response.credential });
          },
        });
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          locale: 'ja',
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, method, submit]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) settle(false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            本人確認
          </DialogTitle>
          <DialogDescription>
            大切な操作のため、もう一度{method === 'google' ? ' Google アカウント' : 'パスワード'}で本人確認してください。
            確認後 10 分間は再入力なしで操作できます。
          </DialogDescription>
        </DialogHeader>

        {method === 'password' ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) void submit({ password });
            }}
          >
            <Input
              type="password"
              autoComplete="current-password"
              placeholder="パスワード"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => settle(false)} disabled={pending}>
                キャンセル
              </Button>
              <Button type="submit" disabled={pending || !password}>
                {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                確認する
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-3">
            <div ref={googleBtnRef} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => settle(false)} disabled={pending}>
                キャンセル
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

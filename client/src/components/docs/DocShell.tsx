import { useEffect } from 'react';
import { Link } from 'wouter';
import { LogoIcon } from '../ui/Logo';
import { useSiteConfig } from '../../hooks/useSiteConfig';

export function DocShell({ children }: { children: React.ReactNode }) {
  const { appName, organizationName, supportEmail } = useSiteConfig();
  useEffect(() => {
    if (!window.location.hash) window.scrollTo(0, 0);
  }, []);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-50 bg-primary text-primary-foreground">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <Link href="/" className="flex items-center gap-3" aria-label={`${appName} ホーム`}>
            <LogoIcon className="w-7 h-7" />
            <span className="text-lg font-semibold">{appName}</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/guide" className="hover:underline">使い方ガイド</Link>
            <Link href="/troubleshooting" className="hover:underline">よくある質問</Link>
            <Link href="/changelog" className="hover:underline">更新履歴</Link>
            <Link href="/" className="hover:underline opacity-80">アプリへ</Link>
          </nav>
        </div>
      </header>
      <main className="container mx-auto px-4 py-8 sm:py-12 flex-1 w-full">{children}</main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Link href="/guide" className="hover:text-primary">使い方ガイド</Link>
          <Link href="/troubleshooting" className="hover:text-primary">よくある質問</Link>
          <Link href="/changelog" className="hover:text-primary">更新履歴</Link>
          {supportEmail && (
            <a href={`mailto:${supportEmail}`} className="hover:text-primary">サポート（{supportEmail}）</a>
          )}
        </div>
        <div className="mt-2">© {organizationName || appName}</div>
      </footer>
    </div>
  );
}

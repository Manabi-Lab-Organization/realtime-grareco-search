import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Menu,
  UserRound,
  Download,
  Shield,
  LogOut,
  BookOpen,
  HelpCircle,
  History,
} from 'lucide-react';
import { LogoIcon } from '../ui/Logo';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { useAuth } from '../../hooks/useAuth';
import { useSiteConfig } from '../../hooks/useSiteConfig';
import { AnnouncementsBell } from '../announcements/AnnouncementsBell';

export function AppHeader() {
  const { user, logout } = useAuth();
  const { appName } = useSiteConfig();
  const [, navigate] = useLocation();

  const headerRef = useRef<HTMLElement>(null);
  const hasUser = !!user;
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const sync = () =>
      document.documentElement.style.setProperty('--app-header-h', `${el.offsetHeight}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasUser]);

  if (!user) return null;

  return (
    <header ref={headerRef} className="sticky top-0 z-50 bg-primary text-primary-foreground">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3 sm:gap-4">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <h1 className="sr-only">{appName}</h1>
          <Link
            href="/"
            aria-label={appName}
            title={appName}
            className="flex items-center gap-1.5 h-8 px-2 sm:px-3.5 rounded-full bg-white text-primary text-sm font-semibold shrink-0"
          >
            <LogoIcon className="w-4 h-4" />
            <span className="hidden sm:inline whitespace-nowrap">{appName}</span>
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="hidden sm:block text-[13px] text-primary-foreground/70 max-w-[180px] truncate"
            title={user.email}
          >
            {user.email}
          </span>
          <button
            onClick={() => logout()}
            className="flex items-center gap-1 h-8 text-[13px] text-primary-foreground/70 hover:text-primary-foreground transition-colors"
            title="ログアウト"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline">ログアウト</span>
          </button>
          <span className="h-5 w-px bg-white/20 mx-1" aria-hidden="true" />
          <AnnouncementsBell variant="light" className="h-8 w-8" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                title="メニュー"
                className="h-8 w-8 text-primary-foreground/70 hover:text-primary-foreground hover:bg-white/10"
              >
                <Menu className="w-5 h-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5 text-sm text-muted-foreground truncate">
                {user.displayName || user.email}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/mypage')}>
                <UserRound className="w-4 h-4" />
                マイページ
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href="/download" target="_blank" rel="noopener noreferrer">
                  <Download className="w-4 h-4" />
                  アプリダウンロード
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href="/guide" target="_blank" rel="noopener noreferrer">
                  <BookOpen className="w-4 h-4" />
                  使い方ガイド
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href="/troubleshooting" target="_blank" rel="noopener noreferrer">
                  <HelpCircle className="w-4 h-4" />
                  よくある質問
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/changelog')}>
                <History className="w-4 h-4" />
                更新履歴
              </DropdownMenuItem>
              {user.role === 'admin' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate('/admin')}>
                    <Shield className="w-4 h-4" />
                    管理画面
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

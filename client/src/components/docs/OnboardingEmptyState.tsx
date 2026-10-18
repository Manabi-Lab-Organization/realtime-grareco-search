import { useState, useEffect } from 'react';
import { Link } from 'wouter';
import { BookOpen, Monitor, Download, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { QUICK_STEPS } from '../../content/guideContent';
import { useSiteConfig } from '../../hooks/useSiteConfig';

const WELCOME_SEEN_KEY = 'grareco_welcome_seen';

function StepsPreview() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {QUICK_STEPS.map((step) => {
        const Icon = step.icon;
        return (
          <div key={step.num} className="rounded-lg border border-border bg-card px-3 py-4 text-center">
            <div className="relative inline-flex mb-2">
              <span className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 text-primary">
                <Icon className="w-5 h-5" />
              </span>
              <span className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                {step.num}
              </span>
            </div>
            <div className="text-sm font-semibold">{step.title}</div>
          </div>
        );
      })}
    </div>
  );
}

function StepsHint() {
  return (
    <div className="flex items-center justify-center gap-x-3 gap-y-2 flex-wrap text-muted-foreground">
      {QUICK_STEPS.map((step, i) => (
        <div key={step.num} className="flex items-center gap-2">
          {i > 0 && <ChevronRight className="w-3.5 h-3.5 opacity-50 -ml-1" aria-hidden />}
          <span className="text-xs font-medium tabular-nums opacity-60">{step.num}</span>
          <span className="text-xs">{step.title}</span>
        </div>
      ))}
    </div>
  );
}

export function OnboardingEmptyState() {
  const { appName } = useSiteConfig();
  const [welcomeOpen, setWelcomeOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(WELCOME_SEEN_KEY)) {
        localStorage.setItem(WELCOME_SEEN_KEY, '1');
        setWelcomeOpen(true);
      }
    } catch {
    }
  }, []);

  const closeWelcome = () => setWelcomeOpen(false);

  return (
    <>
      <Dialog open={welcomeOpen} onOpenChange={(o) => { if (!o) closeWelcome(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-xl">{appName} へようこそ！</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            「録るのはアプリ、見るのはWeb」。かんたん3ステップで始められます。
          </p>
          <div className="my-2">
            <StepsPreview />
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 mt-2">
            <Button variant="outline" onClick={closeWelcome}>あとで</Button>
            <Link href="/guide">
              <Button className="gap-2 w-full sm:w-auto" onClick={closeWelcome}>
                <BookOpen className="w-4 h-4" />
                使い方ガイドを見る
              </Button>
            </Link>
          </div>
        </DialogContent>
      </Dialog>

      <Card>
        <CardContent className="py-10 px-6 text-center">
          <h3 className="text-lg font-semibold mb-1">さっそく始めましょう</h3>
          <p className="text-muted-foreground text-sm mb-6">
            文字起こしはデスクトップアプリ（またはiPhone）で行います。会議が終わると、ここに結果が並びます。
          </p>

          <div className="flex items-center justify-center gap-3 flex-wrap mb-6">
            <Link href="/guide">
              <Button className="gap-2">
                <BookOpen className="w-4 h-4" />
                使い方ガイドを見る
              </Button>
            </Link>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => { window.location.href = 'grareco://open'; }}
            >
              <Monitor className="w-4 h-4" />
              アプリを開く
            </Button>
            <Link href="/download">
              <Button variant="ghost" className="gap-2">
                <Download className="w-4 h-4" />
                ダウンロード
              </Button>
            </Link>
          </div>

          <StepsHint />
        </CardContent>
      </Card>
    </>
  );
}

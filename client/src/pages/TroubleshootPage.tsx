import { useState, useMemo, useEffect } from 'react';
import { Search, X, Copy, Check, Mail } from 'lucide-react';
import { DocShell } from '../components/docs/DocShell';
import { AccordionItem } from '../components/docs/Accordion';
import { FAQ_CATEGORIES } from '../content/faqContent';
import { useSiteConfig } from '../hooks/useSiteConfig';

const INQUIRY_TEMPLATE = `お名前：
ご登録のメールアドレス：
ご利用環境（Mac / Windows / iPhone）とバージョン：
困っていること（どの画面で・何をしたとき・どうなったか）：
発生した日時：
スクリーンショット：（あれば添付してください）`;

export default function TroubleshootPage() {
  const [query, setQuery] = useState('');
  const norm = query.trim().toLowerCase();

  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.replace('#', ''));
    if (hash) {
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const filtered = useMemo(() => {
    if (!norm) return FAQ_CATEGORIES;
    return FAQ_CATEGORIES.map((c) => ({
      ...c,
      items: c.items.filter((it) => (it.q + it.a).toLowerCase().includes(norm)),
    })).filter((c) => c.items.length > 0);
  }, [norm]);

  const hitCount = filtered.reduce((n, c) => n + c.items.length, 0);

  const { appName, supportEmail: SUPPORT_EMAIL } = useSiteConfig();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(INQUIRY_TEMPLATE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  };
  const mailtoHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    `【${appName}】お問い合わせ`,
  )}&body=${encodeURIComponent(INQUIRY_TEMPLATE + '\n')}`;

  return (
    <DocShell>
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold mb-2">よくある質問</h1>
        <p className="text-sm text-muted-foreground mb-6">
          困ったときはここを探してみてください。あわせて{' '}
          <a href="/guide" className="text-primary underline">使い方ガイド</a>
          {' '}もどうぞ。
        </p>

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="キーワードで検索（例：マイク、ログイン）"
            className="w-full rounded-lg border border-border bg-background pl-10 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="検索をクリア"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {norm && (
          <p className="text-xs text-muted-foreground mb-4">
            「{query}」の検索結果：{hitCount}件
          </p>
        )}

        {filtered.length === 0 ? (
          <div className="text-center py-12 text-sm text-muted-foreground">
            該当する質問が見つかりませんでした。
            <br />
            {SUPPORT_EMAIL ? (
              <>
                お困りの場合は{' '}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">{SUPPORT_EMAIL}</a>
                {' '}へお問い合わせください。
              </>
            ) : (
              <>お困りの場合は、管理者にお問い合わせください。</>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {filtered.map((cat) => (
              <section key={cat.id} id={cat.id} className="scroll-mt-24">
                <h2 className="text-sm font-semibold text-primary mb-1">{cat.category}</h2>
                <div>
                  {cat.items.map((it) => (
                    <AccordionItem key={it.q} question={it.q} answer={it.a} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <div id="contact" className="mt-10 scroll-mt-24 rounded-xl border border-border bg-muted/30 px-5 py-5 text-sm">
          <h2 className="text-base font-semibold mb-1">解決しないときは</h2>
          {!SUPPORT_EMAIL ? (
            <p className="text-muted-foreground">
              上で解決しない場合は、管理者にお問い合わせください。
            </p>
          ) : (
          <>
          <p className="text-muted-foreground mb-4">
            上で解決しない場合は{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline font-medium">
              {SUPPORT_EMAIL}
            </a>
            {' '}までメールでお問い合わせください。確認のうえ、順次ご返信いたします。
          </p>
          <p className="text-muted-foreground mb-2">
            下記をコピーしてメール本文に貼り付け、各項目をご記入いただくとスムーズです。
          </p>
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-background px-4 py-3 text-xs leading-6 text-foreground font-sans">{INQUIRY_TEMPLATE}</pre>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
              {copied ? 'コピーしました' : '記入項目をコピー'}
            </button>
            <a
              href={mailtoHref}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity"
            >
              <Mail className="w-4 h-4" />
              この内容でメールを作成
            </a>
          </div>
          </>
          )}
        </div>
      </div>
    </DocShell>
  );
}

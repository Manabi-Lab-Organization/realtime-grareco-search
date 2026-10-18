import ReactMarkdown from 'react-markdown';
import { DocShell } from '../components/docs/DocShell';
import { useReleases } from '../components/desktop/useReleases';
import { useSiteConfig } from '../hooks/useSiteConfig';

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
}

function stripEmoji(text: string): string {
  return text
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}] */gu,
      '',
    );
}

export default function ChangelogPage() {
  const { appName } = useSiteConfig();
  const { data: releases, isLoading, isError } = useReleases();

  return (
    <DocShell>
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold mb-2">更新履歴</h1>
        <p className="text-sm text-muted-foreground mb-8">
          {appName} のアップデート内容をお知らせします。最新版は{' '}
          <a href="/download" className="text-primary underline">ダウンロードページ</a>
          {' '}から入手できます。
        </p>

        {isLoading && (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        )}

        {isError && (
          <div className="text-center py-12 text-sm text-muted-foreground">
            更新履歴を読み込めませんでした。時間をおいて再度お試しください。
          </div>
        )}

        {!isLoading && !isError && (!releases || releases.length === 0) && (
          <div className="text-center py-12 text-sm text-muted-foreground">
            まだ公開された更新履歴はありません。
          </div>
        )}

        {releases && releases.length > 0 && (
          <div className="divide-y divide-border">
            {releases.map((r) => (
              <section key={r.version || r.name} className="py-8 first:pt-0 last:pb-0">
                <div className="flex items-baseline gap-3 flex-wrap mb-4">
                  <h2 className="text-base font-semibold text-foreground">
                    v{r.version}
                  </h2>
                  {r.publishedAt && (
                    <span className="text-xs text-muted-foreground">{formatDate(r.publishedAt)}</span>
                  )}
                  {r.prerelease && (
                    <span className="text-xs text-muted-foreground">プレビュー版</span>
                  )}
                </div>
                {r.body?.trim() ? (
                  <div className="text-sm leading-7 text-foreground [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-5 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-muted-foreground [&_h3]:mt-5 [&_h3]:mb-1 [&_p]:mb-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs">
                    <ReactMarkdown>{stripEmoji(r.body)}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">詳細はありません。</p>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </DocShell>
  );
}

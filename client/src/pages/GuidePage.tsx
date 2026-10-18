import { Link } from 'wouter';
import { ArrowRight, ExternalLink, HelpCircle } from 'lucide-react';
import { DocShell } from '../components/docs/DocShell';
import { CollapsibleSection } from '../components/docs/Accordion';
import { QUICK_STEPS, GUIDE_DETAILS, FEATURE_GUIDE } from '../content/guideContent';

export default function GuidePage() {
  return (
    <DocShell>
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <span className="inline-block text-xs font-semibold tracking-wide text-primary bg-primary/10 rounded-full px-3 py-1 mb-3">
            使い方ガイド
          </span>
          <h1 className="text-2xl sm:text-3xl font-bold mb-3">かんたん3ステップで、はじめよう</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            「録るのはアプリ、見るのはWeb」。最短10分で、会議が自動で図解＆要約されます。
          </p>
        </div>

        <ol className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5 mb-12 list-none p-0">
          {QUICK_STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <li key={step.num} className="relative">
                <div className="h-full bg-card border border-border rounded-xl p-5 flex flex-col items-center text-center shadow-sm">
                  <div className="relative mb-3">
                    <span className="flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 text-primary">
                      <Icon className="w-7 h-7" />
                    </span>
                    <span className="absolute -top-1 -right-1 flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">
                      {step.num}
                    </span>
                  </div>
                  <h2 className="font-semibold text-base mb-1.5">{step.title}</h2>
                  <p className="text-sm text-muted-foreground leading-6">{step.lead}</p>
                  {step.links && (
                    <div className="mt-2 flex flex-col items-center gap-1">
                      {step.links.map((l) =>
                        l.href.startsWith('/') ? (
                          <Link key={l.href} href={l.href} className="text-sm text-primary underline">
                            {l.label}
                          </Link>
                        ) : (
                          <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline">
                            {l.label}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ),
                      )}
                    </div>
                  )}
                  {step.hint && (
                    <p className="mt-3 text-xs text-primary bg-primary/5 rounded-md px-2 py-1.5 leading-5">
                      {step.hint}
                    </p>
                  )}
                </div>
                {i < QUICK_STEPS.length - 1 && (
                  <ArrowRight className="hidden sm:block absolute top-1/2 -right-3.5 -translate-y-1/2 w-5 h-5 text-muted-foreground/40 z-10" />
                )}
              </li>
            );
          })}
        </ol>

        <h2 className="text-lg font-semibold mb-3">もっと詳しく</h2>
        <div className="space-y-2.5 mb-10">
          {GUIDE_DETAILS.map((sec) => (
            <CollapsibleSection key={sec.title} title={sec.title} icon={sec.icon}>
              <ul className="list-disc pl-5 space-y-1.5 text-sm text-muted-foreground leading-7">
                {sec.points.map((p, idx) => (
                  <li key={idx}>{p}</li>
                ))}
              </ul>
            </CollapsibleSection>
          ))}
        </div>

        <h2 className="text-lg font-semibold mb-1">機能ガイド（すべての機能）</h2>
        <p className="text-sm text-muted-foreground mb-3 leading-6">
          ダッシュボードでできることの一覧です。「録音・文字起こしはアプリ、見て・使って・共有するのはWeb」という役割分担になっています。各見出しをタップすると開きます。
        </p>
        <div className="space-y-2.5 mb-10">
          {FEATURE_GUIDE.map((group) => (
            <CollapsibleSection key={group.title} title={group.title} icon={group.icon}>
              {group.intro && (
                <p className="text-sm text-muted-foreground mb-3 leading-6">{group.intro}</p>
              )}
              <ul className="space-y-2.5">
                {group.items.map((item) => (
                  <li key={item.name} className="text-sm leading-6">
                    <span className="font-semibold text-foreground">{item.name}</span>
                    <span className="text-muted-foreground"> — {item.desc}</span>
                  </li>
                ))}
              </ul>
            </CollapsibleSection>
          ))}
        </div>

        <Link
          href="/troubleshooting"
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-5 py-4 hover:border-primary/40 hover:bg-muted/40 transition-colors"
        >
          <span className="flex items-center gap-3">
            <HelpCircle className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium">うまくいかない・もっと知りたいときは「よくある質問」へ</span>
          </span>
          <ArrowRight className="w-4 h-4 text-muted-foreground" />
        </Link>
      </div>
    </DocShell>
  );
}

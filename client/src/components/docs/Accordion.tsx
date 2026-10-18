import { useState } from 'react';
import { Link } from 'wouter';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, type LucideIcon } from 'lucide-react';

function AnswerLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  if (href && href.startsWith('/')) {
    return <Link href={href}>{children}</Link>;
  }
  return (
    <a href={href} target={href?.startsWith('mailto:') ? undefined : '_blank'} rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function CollapsibleSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={open}
      >
        {Icon && (
          <span className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 text-primary shrink-0">
            <Icon className="w-4 h-4" />
          </span>
        )}
        <span className="font-medium text-sm flex-1">{title}</span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="px-4 pb-4 pt-1">{children}</div>}
    </div>
  );
}

export function AccordionItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 py-4 text-left hover:text-primary transition-colors"
        aria-expanded={open}
      >
        <span className="font-medium text-sm">{question}</span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="pb-4 -mt-1 text-sm text-muted-foreground leading-7 [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_ul]:my-1 [&_p]:my-2 [&_strong]:font-semibold">
          <ReactMarkdown components={{ a: AnswerLink }}>{answer}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

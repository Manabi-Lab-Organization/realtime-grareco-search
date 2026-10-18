import { useSiteConfig } from '../../hooks/useSiteConfig';

export function useLegalLinks(): { label: string; href: string }[] {
  const { termsUrl, privacyUrl } = useSiteConfig();
  return [
    ...(termsUrl ? [{ label: '利用規約', href: termsUrl }] : []),
    ...(privacyUrl ? [{ label: 'プライバシーポリシー', href: privacyUrl }] : []),
  ];
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline hover:text-foreground"
    >
      {children}
    </a>
  );
}

export function TermsPrivacyLinks() {
  const links = useLegalLinks();
  if (links.length === 0) return null;
  return (
    <>
      {links.map((l, i) => (
        <span key={l.href}>
          {i > 0 && '・'}
          <ExternalLink href={l.href}>{l.label}</ExternalLink>
        </span>
      ))}
    </>
  );
}

import { useLegalLinks } from '../legal/LegalLinks';
import { useSiteConfig } from '../../hooks/useSiteConfig';

export function Footer() {
  const { appName, organizationName } = useSiteConfig();
  const links = useLegalLinks();
  return (
    <footer className="border-t border-border bg-white dark:bg-slate-950 dark:border-slate-800 py-4">
      <div className="container mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>&copy; {new Date().getFullYear()} {organizationName || appName}</span>
        {links.length > 0 && (
          <nav className="flex gap-4">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        )}
      </div>
    </footer>
  );
}

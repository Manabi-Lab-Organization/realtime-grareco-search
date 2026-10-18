export const PRODUCT_NAME = 'Realtime GraReco & Search';

export interface SiteConfig {
  appName: string;
  organizationName: string;
  supportEmail: string;
  termsUrl: string;
  privacyUrl: string;
}

export function siteConfig(env: NodeJS.ProcessEnv = process.env): SiteConfig {
  const v = (name: string) => (env[name] ?? '').trim();
  return {
    appName: v('APP_NAME') || PRODUCT_NAME,
    organizationName: v('ORGANIZATION_NAME'),
    supportEmail: v('SUPPORT_EMAIL'),
    termsUrl: v('TERMS_URL'),
    privacyUrl: v('PRIVACY_URL'),
  };
}

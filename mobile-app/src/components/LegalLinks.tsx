import { useState } from 'react'
import { Browser } from '@capacitor/browser'
import { useSiteConfig } from '../lib/useSiteConfig'
import LicensesModal from './LicensesModal'

export function LegalLinks() {
  const { termsUrl, privacyUrl } = useSiteConfig()
  const [showLicenses, setShowLicenses] = useState(false)
  const links = [
    ...(termsUrl ? [{ label: '利用規約', href: termsUrl }] : []),
    ...(privacyUrl ? [{ label: 'プライバシーポリシー', href: privacyUrl }] : []),
  ]
  return (
    <>
      <nav className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[10px] text-gray-500">
        {links.map((link) => (
          <button
            key={link.href}
            type="button"
            onClick={() => void Browser.open({ url: link.href, presentationStyle: 'popover' })}
            className="underline"
          >
            {link.label}
          </button>
        ))}
        <button type="button" onClick={() => setShowLicenses(true)} className="underline">
          ライセンス
        </button>
      </nav>
      {showLicenses && <LicensesModal onClose={() => setShowLicenses(false)} />}
    </>
  )
}

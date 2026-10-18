import { useSiteConfig } from '../hooks/useSiteConfig'

export function LegalLinks({ serverURL }: { serverURL?: string }) {
  const { termsUrl, privacyUrl } = useSiteConfig(serverURL)
  const links = [
    ...(termsUrl ? [{ label: '利用規約', href: termsUrl }] : []),
    ...(privacyUrl ? [{ label: 'プライバシーポリシー', href: privacyUrl }] : []),
  ]
  return (
    <nav className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[10px] text-gray-400">
      {links.map((link) => (
        <button
          key={link.href}
          type="button"
          onClick={() => void window.electronAPI.openExternal(link.href)}
          className="underline hover:text-gray-600 cursor-pointer"
        >
          {link.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => void window.electronAPI.openThirdPartyNotices()}
        className="underline hover:text-gray-600 cursor-pointer"
        title="アプリに同梱しているライブラリのライセンス表示を開きます"
      >
        ライセンス
      </button>
    </nav>
  )
}

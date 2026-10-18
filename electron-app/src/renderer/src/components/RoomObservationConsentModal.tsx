import { useSiteConfig } from '../hooks/useSiteConfig'
import {
  PRIVACY_POLICY_LABEL,
  ROOM_OBSERVATION_CONSENT_TEXT as T,
} from '../lib/roomObservationConsent'

interface Props {
  busy: boolean
  error: string | null
  onAgree: () => void
  onDecline: () => void
}

export function RoomObservationConsentModal({ busy, error, onAgree, onDecline }: Props): React.JSX.Element {
  const { privacyUrl } = useSiteConfig()
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="room-observation-consent-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto">
        <h3 id="room-observation-consent-title" className="text-base font-bold text-gray-900">
          {T.title}
        </h3>

        <p className="text-sm text-gray-800 leading-relaxed">{T.lead}</p>
        {T.sections.map((section) => (
          <div key={section.heading}>
            <h4 className="text-xs font-bold text-gray-900 mb-1.5">{section.heading}</h4>
            <BulletList items={section.items} privacyUrl={privacyUrl} />
          </div>
        ))}
        <div className="pt-3 border-t border-gray-200">
          <BulletList items={T.notes} privacyUrl={privacyUrl} />
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onDecline}
            disabled={busy}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition cursor-pointer disabled:opacity-40"
          >
            {T.decline}
          </button>
          <button
            onClick={onAgree}
            disabled={busy}
            className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition cursor-pointer disabled:opacity-40"
          >
            {busy ? '送信中…' : T.agree}
          </button>
        </div>
      </div>
    </div>
  )
}

function BulletList({ items, privacyUrl }: { items: readonly string[]; privacyUrl: string }): React.JSX.Element {
  return (
    <ul className="space-y-2 text-xs text-gray-700 leading-relaxed">
      {items.map((item) => (
        <li key={item} className="flex gap-1.5">
          <span className="text-brand-600 shrink-0">・</span>
          <span>{renderWithPrivacyLink(item, privacyUrl)}</span>
        </li>
      ))}
    </ul>
  )
}

function renderWithPrivacyLink(text: string, privacyUrl: string): React.ReactNode {
  const i = text.indexOf(PRIVACY_POLICY_LABEL)
  if (i < 0 || !privacyUrl) return text
  return (
    <>
      {text.slice(0, i)}
      <button
        type="button"
        onClick={() => void window.electronAPI.openExternal(privacyUrl)}
        className="text-brand-600 underline cursor-pointer"
      >
        {PRIVACY_POLICY_LABEL}
      </button>
      {text.slice(i + PRIVACY_POLICY_LABEL.length)}
    </>
  )
}

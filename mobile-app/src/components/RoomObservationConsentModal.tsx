import { Browser } from '@capacitor/browser'
import { useSiteConfig } from '../lib/useSiteConfig'
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

export default function RoomObservationConsentModal({ busy, error, onAgree, onDecline }: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="room-observation-consent-title"
      className="fixed inset-0 z-50 bg-gray-950/95 flex flex-col p-4 pt-12"
      style={{ paddingTop: 'max(3rem, env(safe-area-inset-top))' }}
    >
      <h2 id="room-observation-consent-title" className="text-base font-semibold text-white mb-3">
        {T.title}
      </h2>

      <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-gray-800 bg-gray-900/60 p-4">
        <p className="text-sm text-gray-100 leading-relaxed">{T.lead}</p>
        {T.sections.map((section) => (
          <div key={section.heading} className="mt-4">
            <h3 className="text-sm font-semibold text-teal-300 mb-1.5">{section.heading}</h3>
            <BulletList items={section.items} />
          </div>
        ))}
        <div className="mt-4 pt-3 border-t border-gray-800">
          <BulletList items={T.notes} />
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-red-400 leading-relaxed">{error}</p>}

      <div
        className="mt-4 flex flex-col gap-2"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <button
          type="button"
          onClick={onAgree}
          disabled={busy}
          className="w-full py-3.5 rounded-xl text-base font-semibold border-2 border-teal-500 bg-teal-600 text-white active:bg-teal-700 disabled:opacity-50"
        >
          {busy ? '送信中…' : T.agree}
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={busy}
          className="w-full py-3.5 rounded-xl text-base font-medium border-2 border-gray-700 bg-gray-900 text-gray-300 active:bg-gray-800 disabled:opacity-50"
        >
          {T.decline}
        </button>
      </div>
    </div>
  )
}

function BulletList({ items }: { items: readonly string[] }) {
  const { privacyUrl } = useSiteConfig()
  return (
    <ul className="space-y-2 text-sm text-gray-200 leading-relaxed">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span className="text-teal-400 shrink-0">・</span>
          <span>{renderWithPrivacyLink(item, privacyUrl)}</span>
        </li>
      ))}
    </ul>
  )
}

function renderWithPrivacyLink(text: string, privacyUrl: string) {
  const i = text.indexOf(PRIVACY_POLICY_LABEL)
  if (i < 0 || !privacyUrl) return text
  return (
    <>
      {text.slice(0, i)}
      <button
        type="button"
        onClick={() => void Browser.open({ url: privacyUrl, presentationStyle: 'popover' })}
        className="text-blue-400 underline"
      >
        {PRIVACY_POLICY_LABEL}
      </button>
      {text.slice(i + PRIVACY_POLICY_LABEL.length)}
    </>
  )
}

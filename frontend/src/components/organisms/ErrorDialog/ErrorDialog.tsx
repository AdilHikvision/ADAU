import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '../../../lib/clipboard'

/* ═══ Единое окно ошибок: одна крупная понятная фраза сверху, построчные подробности
   (например, что ответило каждое устройство) — ниже, а технический текст прячется
   под «Подробности», чтобы не пугать оператора. ═══ */

export interface ErrorDialogProps {
  open: boolean
  onClose: () => void
  /** error — красное окно (действие не выполнено), warning — жёлтое (выполнено с замечаниями). */
  variant?: 'error' | 'warning'
  title?: string
  /** Основное сообщение. Если содержит переводы строк, хвост уходит в подробности. */
  message: string
  /** Дополнительные строки: по устройству, по полю и т.п. */
  details?: string[]
  hint?: string
  onRetry?: () => void
  retryLabel?: string
}

const SKIN = {
  error: {
    ring: 'ring-error-text/15',
    halo: 'bg-error-bg text-error-text',
    glow: 'shadow-[0_10px_30px_-10px_rgba(217,83,74,0.55)]',
    accent: 'bg-error-text',
    icon: 'error',
  },
  warning: {
    ring: 'ring-warning-text/15',
    halo: 'bg-warning-bg text-warning-text',
    glow: 'shadow-[0_10px_30px_-10px_rgba(196,141,26,0.5)]',
    accent: 'bg-warning-text',
    icon: 'warning',
  },
} as const

export function ErrorDialog({
  open,
  onClose,
  variant = 'error',
  title,
  message,
  details,
  hint,
  onRetry,
  retryLabel,
}: ErrorDialogProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)

  // Esc закрывает окно; при каждом новом открытии подробности снова свёрнуты.
  useEffect(() => {
    if (!open) return
    setShowRaw(false)
    setCopied(false)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const skin = SKIN[variant]
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean)
  const headline = lines[0] ?? t('errorDialog.title')
  const rest = [...lines.slice(1), ...(details ?? [])]
  const rawText = [message, ...(details ?? [])].join('\n')

  const copy = async () => {
    try {
      if (!(await copyToClipboard(rawText))) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* буфер недоступен — не страшно */ }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text-dark/35 backdrop-blur-sm cursor-pointer" onClick={onClose} aria-hidden />

      <div
        role="alertdialog"
        aria-modal="true"
        className="relative w-full max-w-md max-h-[85vh] flex flex-col rounded-[22px] bg-surface border border-border-light shadow-float animate-pop overflow-hidden"
      >
        {/* Цветная полоса сверху — сразу видно тяжесть события */}
        <div className={`h-1 w-full ${skin.accent}`} />

        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="absolute top-3.5 right-3.5 w-8 h-8 grid place-items-center rounded-lg text-text-light hover:text-text-dark hover:bg-background-light transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>

        <div className="px-7 pt-7 pb-2 flex flex-col items-center text-center">
          <div className={`w-14 h-14 rounded-2xl grid place-items-center ring-8 ${skin.ring} ${skin.halo} ${skin.glow}`}>
            <span className="material-symbols-outlined icon-fill text-[28px]">{skin.icon}</span>
          </div>
          <h2 className="mt-4 text-[17px] font-bold tracking-[-0.3px] text-text-dark">
            {title ?? t(variant === 'warning' ? 'errorDialog.warningTitle' : 'errorDialog.title')}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-text-light whitespace-pre-wrap break-words">{headline}</p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-7">
          {rest.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1.5">
              {rest.map((line, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 rounded-xl bg-background-light px-3.5 py-2.5 text-[12px] leading-relaxed text-text-dark"
                >
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${skin.accent}`} />
                  <span className="min-w-0 break-words whitespace-pre-wrap">{line}</span>
                </li>
              ))}
            </ul>
          )}

          {hint && (
            <div className="mt-4 flex items-start gap-2 rounded-xl bg-primary/5 px-3.5 py-3">
              <span className="material-symbols-outlined text-[16px] text-primary shrink-0">lightbulb</span>
              <p className="text-[11.5px] leading-relaxed text-primary">{hint}</p>
            </div>
          )}

          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-text-light hover:text-text-dark transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">{showRaw ? 'expand_less' : 'expand_more'}</span>
              {t('errorDialog.detailsLabel')}
            </button>
            {showRaw && (
              <div className="mt-2 relative">
                <pre className="max-h-40 overflow-auto rounded-xl bg-[#F6F6FA] p-3 pr-10 text-[11px] leading-relaxed text-[#4A4B6B] whitespace-pre-wrap break-words">
                  {rawText}
                </pre>
                <button
                  type="button"
                  onClick={copy}
                  title={t(copied ? 'errorDialog.copied' : 'errorDialog.copy')}
                  className="absolute top-2 right-2 w-7 h-7 grid place-items-center rounded-lg bg-surface text-text-light hover:text-primary shadow-sm"
                >
                  <span className="material-symbols-outlined text-[15px]">{copied ? 'check' : 'content_copy'}</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-2 px-7 py-6">
          {onRetry && (
            <button
              type="button"
              onClick={() => { onClose(); onRetry() }}
              className="flex-1 h-11 rounded-xl bg-primary text-white text-[12.5px] font-semibold hover:opacity-90 transition-opacity"
            >
              {retryLabel ?? t('common.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`${onRetry ? 'flex-1' : 'w-full'} h-11 rounded-xl bg-background-light text-text-dark text-[12.5px] font-semibold hover:bg-[#EAE9F2] transition-colors`}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

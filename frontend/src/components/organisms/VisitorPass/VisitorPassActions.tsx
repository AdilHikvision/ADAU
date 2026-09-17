import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  renderVisitorTicket,
  ticketFileName,
  type VisitorTicketData,
} from './renderVisitorTicket'

/**
 * Кнопки «скачать пропуск» и «поделиться» на карточке гостя.
 *
 * Делимся картинкой-билетом, а не голым QR: у гостя в мессенджере остаётся
 * пропуск, по которому видно, кто, куда и до какого времени проходит.
 *
 * Файл в мессенджер умеет отдать только navigator.share — на телефоне он и
 * открывает WhatsApp, Telegram, Instagram и всё остальное, что установлено.
 * Веб-ссылки мессенджеров принимают лишь текст, поэтому на десктопе билет
 * скачивается, а ссылка открывает чат с подписью — картинку туда пользователь
 * прикладывает сам.
 */
export function VisitorPassActions({
  cardNo,
  fullName,
  companyName,
  department,
  accessLevels,
  documentNumber,
  validFromUtc,
  validToUtc,
}: VisitorTicketData & { companyName?: string | null }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<'download' | 'share' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // blob: URL живёт до размонтирования — иначе Safari отзывает его слишком рано.
  const objectUrl = useRef<string | null>(null)

  useEffect(() => () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
  }, [])

  const data: VisitorTicketData = {
    cardNo, fullName, companyName, department, accessLevels,
    documentNumber, validFromUtc, validToUtc,
  }

  const labels = {
    title: t('visitorPass.ticketTitle'),
    guest: t('visitorPass.guest'),
    where: t('visitorPass.where'),
    from: t('visitorPass.validFrom'),
    to: t('visitorPass.validTo'),
    document: t('visitorPass.document'),
    pass: t('visitorPass.pass'),
    hint: t('visitorPass.scanHint'),
  }

  async function buildTicket() {
    const blob = await renderVisitorTicket(data, labels)
    return { blob, name: ticketFileName(fullName, cardNo) }
  }

  async function handleDownload() {
    setError(null)
    setBusy('download')
    try {
      const { blob, name } = await buildTicket()
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl.current
      a.download = name
      a.click()
    } catch {
      setError(t('visitorPass.failed'))
    } finally {
      setBusy(null)
    }
  }

  /** Текст-подпись к билету — уходит и в системный share, и в ссылки мессенджеров. */
  function shareText() {
    return t('visitorPass.shareText', {
      name: fullName,
      company: companyName?.trim() || t('visitorPass.pass'),
    })
  }

  async function handleShare() {
    setError(null)
    setBusy('share')
    try {
      const { blob, name } = await buildTicket()
      const file = new File([blob], name, { type: 'image/png' })

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: labels.pass, text: shareText() })
        return
      }
      // Системного диалога нет (обычно десктоп): отдаём файл и показываем
      // ссылки на мессенджеры — иначе поделиться было бы нечем.
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl.current
      a.download = name
      a.click()
      setMenuOpen(true)
    } catch (e) {
      // Пользователь закрыл системный диалог — это не ошибка.
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(t('visitorPass.failed'))
    } finally {
      setBusy(null)
    }
  }

  const text = encodeURIComponent(shareText())
  const links: Array<{ key: string; href: string }> = [
    { key: 'whatsapp', href: `https://wa.me/?text=${text}` },
    { key: 'telegram', href: `https://t.me/share/url?url=&text=${text}` },
    { key: 'email', href: `mailto:?subject=${encodeURIComponent(labels.pass)}&body=${text}` },
  ]

  const btn = 'w-8 h-8 grid place-items-center rounded-xl bg-surface shadow text-text-muted hover:text-primary disabled:opacity-40 transition-colors'

  return (
    <div className="relative flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={handleDownload}
        disabled={busy !== null}
        title={t('visitorPass.download')}
        aria-label={t('visitorPass.download')}
        className={btn}
      >
        <span className="material-symbols-outlined text-[17px]">
          {busy === 'download' ? 'hourglass_top' : 'download'}
        </span>
      </button>
      <button
        type="button"
        onClick={handleShare}
        disabled={busy !== null}
        title={t('visitorPass.share')}
        aria-label={t('visitorPass.share')}
        className={btn}
      >
        <span className="material-symbols-outlined text-[17px]">
          {busy === 'share' ? 'hourglass_top' : 'share'}
        </span>
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-xl border border-border-base bg-white p-2 shadow-lg">
            <p className="px-2 pt-1 pb-2 text-[10px] leading-snug text-text-light">
              {t('visitorPass.desktopHint')}
            </p>
            {links.map(({ key, href }) => (
              <a
                key={key}
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-bold text-text-dark hover:bg-slate-75"
              >
                {t(`visitorPass.via.${key}`)}
              </a>
            ))}
          </div>
        </>
      )}

      {error && (
        <span className="absolute right-0 top-full mt-1 whitespace-nowrap rounded-md bg-error-bg px-2 py-1 text-[10px] font-bold text-error-text">
          {error}
        </span>
      )}
    </div>
  )
}

import QRCode from 'qrcode'

/** Данные, которые попадают на билет. */
export interface VisitorTicketData {
  /** Что закодировано в QR — номер карты, который принимает считыватель. */
  cardNo: string
  fullName: string
  /** Организация-хозяин: шапка билета. */
  companyName?: string | null
  /** Куда пропускается: отдел и/или уровни доступа. */
  department?: string | null
  accessLevels?: string[]
  documentNumber?: string | null
  validFromUtc?: string | null
  validToUtc?: string | null
}

/** Подписи — приходят снаружи, чтобы билет говорил на языке интерфейса. */
export interface VisitorTicketLabels {
  title: string
  guest: string
  where: string
  from: string
  to: string
  document: string
  pass: string
  hint: string
}

// Билет рисуется в двойном масштабе: скачанный PNG остаётся чётким при печати
// и при просмотре на экранах с высокой плотностью.
const S = 2
const W = 640
const H = 940

const BRAND = '#6e56cf'
const BRAND_DEEP = '#4c37a8'
const INK = '#16131f'
const MUTED = '#6e6980'
const FAINT = '#a09aaf'
const PAPER = '#ffffff'
const CANVAS_BG = '#eceaf4'

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function font(size: number, weight: number | string = 400) {
  return `${weight} ${size}px "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
}

/** Обрезает строку по ширине, добавляя многоточие. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1)
  return s + '…'
}

function formatDateTime(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} · ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Рисует пропуск-билет: шапка организации, имя гостя, куда и на какой срок
 * действует пропуск, и QR, который считывает турникет.
 *
 * Возвращает PNG: им можно и поделиться через navigator.share, и сохранить.
 */
export async function renderVisitorTicket(
  data: VisitorTicketData,
  labels: VisitorTicketLabels,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = W * S
  canvas.height = H * S
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  ctx.scale(S, S)
  ctx.textBaseline = 'alphabetic'

  // Подложка — билет «лежит» на светлом фоне, поля видны при вставке в чат.
  ctx.fillStyle = CANVAS_BG
  ctx.fillRect(0, 0, W, H)

  const M = 28
  const cardX = M
  const cardY = M
  const cardW = W - M * 2
  const cardH = H - M * 2

  // Тень билета.
  ctx.save()
  ctx.shadowColor = 'rgba(22, 19, 31, 0.18)'
  ctx.shadowBlur = 28
  ctx.shadowOffsetY = 10
  ctx.fillStyle = PAPER
  roundRect(ctx, cardX, cardY, cardW, cardH, 28)
  ctx.fill()
  ctx.restore()

  // ── Шапка ────────────────────────────────────────────────────────────────
  const headerH = 132
  ctx.save()
  roundRect(ctx, cardX, cardY, cardW, cardH, 28)
  ctx.clip()

  const grad = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + headerH)
  grad.addColorStop(0, BRAND)
  grad.addColorStop(1, BRAND_DEEP)
  ctx.fillStyle = grad
  ctx.fillRect(cardX, cardY, cardW, headerH)

  // Полупрозрачные круги — лёгкий объём, чтобы шапка не была плоской заливкой.
  ctx.fillStyle = 'rgba(255,255,255,0.10)'
  ctx.beginPath()
  ctx.arc(cardX + cardW - 40, cardY + 18, 92, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(cardX + cardW - 130, cardY + headerH - 6, 54, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.fillStyle = 'rgba(255,255,255,0.72)'
  ctx.font = font(12, 800)
  const kicker = labels.title.toUpperCase()
  ctx.letterSpacing = '2px'
  ctx.fillText(kicker, cardX + 32, cardY + 48)
  ctx.letterSpacing = '0px'

  ctx.fillStyle = '#ffffff'
  ctx.font = font(26, 800)
  ctx.fillText(fit(ctx, data.companyName?.trim() || labels.pass, cardW - 64), cardX + 32, cardY + 88)

  // ── Имя гостя ────────────────────────────────────────────────────────────
  let y = cardY + headerH + 46
  ctx.fillStyle = FAINT
  ctx.font = font(11, 800)
  ctx.letterSpacing = '1.8px'
  ctx.fillText(labels.guest.toUpperCase(), cardX + 32, y)
  ctx.letterSpacing = '0px'

  y += 34
  ctx.fillStyle = INK
  ctx.font = font(30, 800)
  ctx.fillText(fit(ctx, data.fullName, cardW - 64), cardX + 32, y)

  // ── Куда пропускается ────────────────────────────────────────────────────
  const zones = [data.department, ...(data.accessLevels ?? [])]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)

  y += 44
  ctx.fillStyle = FAINT
  ctx.font = font(11, 800)
  ctx.letterSpacing = '1.8px'
  ctx.fillText(labels.where.toUpperCase(), cardX + 32, y)
  ctx.letterSpacing = '0px'

  y += 26
  ctx.fillStyle = INK
  ctx.font = font(16, 600)
  ctx.fillText(fit(ctx, zones.length ? zones.join(' · ') : '—', cardW - 64), cardX + 32, y)

  // ── Срок действия: две колонки ───────────────────────────────────────────
  y += 40
  const colW = (cardW - 64 - 16) / 2
  const cells: Array<[string, string]> = [
    [labels.from, formatDateTime(data.validFromUtc)],
    [labels.to, formatDateTime(data.validToUtc)],
  ]
  cells.forEach(([label, value], i) => {
    const x = cardX + 32 + i * (colW + 16)
    ctx.fillStyle = '#f6f5fb'
    roundRect(ctx, x, y, colW, 74, 14)
    ctx.fill()

    ctx.fillStyle = FAINT
    ctx.font = font(10, 800)
    ctx.letterSpacing = '1.6px'
    ctx.fillText(label.toUpperCase(), x + 16, y + 26)
    ctx.letterSpacing = '0px'

    ctx.fillStyle = INK
    ctx.font = font(15, 700)
    ctx.fillText(fit(ctx, value, colW - 32), x + 16, y + 52)
  })

  // ── Перфорация ───────────────────────────────────────────────────────────
  // Отрыв считаем от низа блока с датами, а не константой: иначе при правке
  // отступов выше корешок разъезжается с содержимым.
  const notchY = y + 74 + 52

  // Корешок с QR слегка притенён — визуально отделяется от верхней части.
  ctx.save()
  roundRect(ctx, cardX, cardY, cardW, cardH, 28)
  ctx.clip()
  ctx.fillStyle = '#fbfaff'
  ctx.fillRect(cardX, notchY, cardW, cardY + cardH - notchY)
  ctx.restore()

  ctx.fillStyle = CANVAS_BG
  ctx.beginPath()
  ctx.arc(cardX, notchY, 16, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(cardX + cardW, notchY, 16, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = '#e4e1ee'
  ctx.lineWidth = 2
  ctx.setLineDash([7, 9])
  ctx.beginPath()
  ctx.moveTo(cardX + 26, notchY)
  ctx.lineTo(cardX + cardW - 26, notchY)
  ctx.stroke()
  ctx.setLineDash([])

  // ── QR ───────────────────────────────────────────────────────────────────
  const qrSize = 250
  const qrX = cardX + (cardW - qrSize) / 2
  const qrY = notchY + 48

  const qrUrl = await QRCode.toDataURL(data.cardNo, {
    width: qrSize * S,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#16131fff', light: '#ffffffff' },
  })
  const qrImg = new Image()
  await new Promise<void>((resolve, reject) => {
    qrImg.onload = () => resolve()
    qrImg.onerror = () => reject(new Error('QR render failed'))
    qrImg.src = qrUrl
  })

  // Рамка вокруг кода — он не сливается с бумагой при печати.
  ctx.strokeStyle = '#ecebf4'
  ctx.lineWidth = 2
  roundRect(ctx, qrX - 14, qrY - 14, qrSize + 28, qrSize + 28, 18)
  ctx.stroke()
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize)

  // ── Номер карты и документ ───────────────────────────────────────────────
  let footY = qrY + qrSize + 44
  ctx.textAlign = 'center'
  ctx.fillStyle = INK
  ctx.font = font(18, 800)
  ctx.letterSpacing = '3px'
  ctx.fillText(fit(ctx, data.cardNo, cardW - 64), cardX + cardW / 2, footY)
  ctx.letterSpacing = '0px'

  if (data.documentNumber?.trim()) {
    footY += 26
    ctx.fillStyle = MUTED
    ctx.font = font(12, 600)
    ctx.fillText(
      fit(ctx, `${labels.document}: ${data.documentNumber.trim()}`, cardW - 64),
      cardX + cardW / 2,
      footY,
    )
  }

  footY += 30
  ctx.fillStyle = FAINT
  ctx.font = font(11, 500)
  ctx.fillText(fit(ctx, labels.hint, cardW - 72), cardX + cardW / 2, footY)
  ctx.textAlign = 'left'

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Ticket export failed'))),
      'image/png',
    )
  })
}

/** Имя файла билета: латиница и цифры, чтобы не ломалось при отправке. */
export function ticketFileName(fullName: string, cardNo: string) {
  const slug = fullName
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  return `pass-${slug || 'guest'}-${cardNo}.png`
}
